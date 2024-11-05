const express = require("express");
const path = require("path")
const addon = express();
const { getCatalog } = require("./lib/getCatalog");
const { getSearch } = require("./lib/getSearch");
const { getManifest, DEFAULT_LANGUAGE } = require("./lib/getManifest");
const { getMeta } = require("./lib/getMeta");
const { getTmdb } = require("./lib/getTmdb");
const { cacheWrapMeta } = require("./lib/getCache");
const { getTrending } = require("./lib/getTrending");
const { parseConfig, getAiorPoster, checkIfExists } = require("./utils/parseProps");
const { getRequestToken, getSessionId } = require("./lib/getSession");
const { getFavorites, getWatchList } = require("./lib/getPersonalLists");

const getCacheHeaders = function (opts) {
  opts = opts || {};

  if (!Object.keys(opts).length) return false;

  let cacheHeaders = {
    cacheMaxAge: "max-age",
    staleRevalidate: "stale-while-revalidate",
    staleError: "stale-if-error",
  };

  return Object.keys(cacheHeaders)
    .map((prop) => {
      const value = opts[prop];
      if (!value) return false;
      return cacheHeaders[prop] + "=" + value;
    })
    .filter((val) => !!val)
    .join(", ");
};

const respond = function (res, data, opts) {
  const cacheControl = getCacheHeaders(opts);
  if (cacheControl) res.setHeader("Cache-Control", `${cacheControl}, public`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json");
  res.send(data);
};

addon.get("/", async function (_, res) {
  res.redirect("/configure");
});

addon.get("/request_token", async function (req, res) {
  const requestToken = await getRequestToken()
  respond(res, requestToken);
});

addon.get("/session_id", async function (req, res) {
  const requestToken = req.query.request_token
  const sessionId = await getSessionId(requestToken)
  respond(res, sessionId);
});

addon.get("/:catalogChoices?/configure", async function (req, res) {
  res.sendFile(path.join(__dirname + "/configure.html"));
});

addon.get("/:catalogChoices?/manifest.json", async function (req, res) {
  const { catalogChoices } = req.params;
  const config = parseConfig(catalogChoices);
  const manifest = await getManifest(config);
  const cacheOpts = {
    cacheMaxAge: 12 * 60 * 60, // 12 hours
    staleRevalidate: 14 * 24 * 60 * 60, // 14 days
    staleError: 30 * 24 * 60 * 60, // 30 days
  };
  respond(res, manifest, cacheOpts);
});

addon.get("/:catalogChoices?/catalog/:type/:id/:extra?.json", async function (req, res) {
  const { catalogChoices, type, id } = req.params;
  const config = parseConfig(catalogChoices)
  console.log(config)
  const language = config.language || DEFAULT_LANGUAGE;
  const include_adult = config.include_adult || false
  const aiorkey = config.aiorkey
  const sessionId = config.sessionId
  const { genre, skip, search } = req.params.extra
    ? Object.fromEntries(
      new URLSearchParams(req.url.split("/").pop().split("?")[0].slice(0, -5)).entries()
    )
    : {};
  const page = Math.ceil(skip ? skip / 20 + 1 : undefined) || 1;
  let metas = [];
  try {
    const args = [type, language, page];

    if (search) {
      metas = await getSearch(type, language, search, include_adult);
    } else {
      switch (id) {
        case "tmdb.trending":
          metas = await getTrending(...args, genre);
          break;
        case "tmdb.favorites":
          metas = await getFavorites(...args, sessionId);
          break;
        case "tmdb.watchlist":
          metas = await getWatchList(...args, sessionId);
          break;
        default:
          metas = await getCatalog(...args, id, genre);
          break;
      }
    }
  } catch (e) {
    res.status(404).send((e || {}).message || "Not found");
    return;
  }
  const cacheOpts = {
    cacheMaxAge: 7 * 24 * 60 * 60, // 7 days
    staleRevalidate: 14 * 24 * 60 * 60, // 14 days
    staleError: 30 * 24 * 60 * 60, // 30 days
  };
  if (id === "tmdb.trending" && genre === "Day") {
    cacheOpts.cacheMaxAge = 1 * 24 * 60 * 60; // 1 day
  }
  if (aiorkey) {
    console.log("aiorkey", aiorkey)
    // clone response before changing posters
    try {
      metas = JSON.parse(JSON.stringify(metas));
      metas.metas = await Promise.all(metas.metas.map(async (el) => {
        const aiorImage = getAiorPoster(type, el.id.replace('tmdb:', ''), aiorkey)
        el.poster = await checkIfExists(aiorImage) ? aiorImage : el.poster;
        return el;
      }))
    } catch (e) { }
  }
  respond(res, metas, cacheOpts);
});

addon.get("/:catalogChoices?/meta/:type/:id.json", async function (req, res) {
  const { catalogChoices, type, id } = req.params;
  const config = parseConfig(catalogChoices);
  console.log(config,'meta')
  const tmdbId = id.split(":")[1];
  const language = config.language || DEFAULT_LANGUAGE;
  const aiorkey = config.aiorkey
  const imdbId = req.params.id.split(":")[0];

  if (req.params.id.includes("tmdb:")) {
    const resp = await cacheWrapMeta(`${language}:${type}:${tmdbId}`, async () => {
      return await getMeta(type, language, tmdbId, aiorkey)
    });
    const cacheOpts = {
      staleRevalidate: 20 * 24 * 60 * 60, // 20 days
      staleError: 30 * 24 * 60 * 60, // 30 days
    };
    if (type == "movie") {
      // cache movies for 14 days:
      cacheOpts.cacheMaxAge = 14 * 24 * 60 * 60;
    } else if (type == "series") {
      const hasEnded = !!((resp.releaseInfo || "").length > 5);
      // cache series that ended for 14 days, otherwise 1 day:
      cacheOpts.cacheMaxAge = (hasEnded ? 14 : 1) * 24 * 60 * 60;
    }
    respond(res, resp, cacheOpts);
  }
  if (req.params.id.includes("tt")) {
    const tmdbId = await getTmdb(type, imdbId);
    if (tmdbId) {
      const resp = await cacheWrapMeta(`${language}:${type}:${tmdbId}`, async () => {
        return await getMeta(type, language, tmdbId, aiorkey)
      });
      const cacheOpts = {
        staleRevalidate: 20 * 24 * 60 * 60, // 20 days
        staleError: 30 * 24 * 60 * 60, // 30 days
      };
      if (type == "movie") {
        // cache movies for 14 days:
        cacheOpts.cacheMaxAge = 14 * 24 * 60 * 60;
      } else if (type == "series") {
        const hasEnded = !!((resp.releaseInfo || "").length > 5);
        // cache series that ended for 14 days, otherwise 1 day:
        cacheOpts.cacheMaxAge = (hasEnded ? 14 : 1) * 24 * 60 * 60;
      }
      respond(res, resp, cacheOpts);
    } else {
      respond(res, { meta: {} });
    }
  }
});

module.exports = addon;

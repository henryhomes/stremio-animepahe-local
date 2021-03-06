const needle = require('needle')
const async = require('async')
const pUrl = require('url').parse
const db = require('./lib/cache')
const cloudscraper = require('cloudscraper')
const { proxy } = require('internal')

const manifest = {
    id: 'org.animepahe.anime',
    version: '1.0.3',
    logo: 'https://marcelinethinks.files.wordpress.com/2015/11/anime-logo-square.png',
    name: 'AnimePahe',
    description: 'Anime from AnimePahe',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series', 'movie'],
    idPrefixes: ['kitsu:'],
    catalogs: [
      {
        type: 'series',
        id: 'animepahe-search',
        name: 'AnimePahe',
        extra: [
          {
            name: 'search',
            isRequired: true
          }
        ]
      }, {
        type: 'series',
        id: 'animepahe-latest',
        name: 'AnimePahe',
        extra: [
          {
            name: 'skip'
          }
        ]
      }
    ]
}

const { addonBuilder, getRouter }  = require('stremio-addon-sdk')

const addon = new addonBuilder(manifest)

const endpoint = 'https://animepahe.com/api'

const headers = {
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/72.0.3626.121 Safari/537.36',
  'Referer': 'https://animepahe.com/',
}

const cache = {
  metas: {}
}

function toMeta(id, obj) {
  return {
    id,
    name: obj.title,
    poster: obj.image,
    type: 'series'
  }
}

const kitsuEndpoint = 'https://stremio-kitsu.now.sh'

const mapToKitsu = {}

let pages = {}

addon.defineCatalogHandler(args => {
  return new Promise((resolve, reject) => {

    function findPage(target) {
      if (!target)
        return 1
      let sum = 0
      let atPage = 0
      let lastKey
      for (key in pages) {
        sum += pages[key]
        if (!atPage && sum >= target)
          atPage = parseInt(key)+1
        lastKey = key
      }
      return !atPage ? parseInt(lastKey)+1 : atPage
    }

    const page = findPage(args.extra.skip)

    let url = endpoint

    if (args.id == 'animepahe-latest') {
      if (page == 1) pages = {} // reset page map
      url += '?m=airing&l=36&page=' + page
    } else
      url += '?m=search&l=8&q=' + encodeURIComponent(args.extra.search)

    if (cache.metas[url]) {
      resolve({ metas: cache.metas[url], cacheMaxAge: 2 * 60 * 60 })
      return
    }

    const redisKey = args.extra.search ? null : (args.extra.genre || 'default') + '-' + page

    db.catalog.get(redisKey, page, redisMetas => {

      if (redisMetas)
        resolve({ metas: redisMetas, cacheMaxAge: 30 * 60 })

      cloudscraper.get({ uri: url, headers }).then((body) => {
        if (typeof body === 'string')
          try {
            body = JSON.parse(body)
          } catch(e) {}
        const series = (body || {}).data || []
        const metas = []
        if (series.length) {
          const queue = async.queue((task, cb) => {
            const animeId = task.anime_id || task.id
            if (mapToKitsu[animeId]) {
              metas.push(toMeta(mapToKitsu[animeId], task))
              cb()
              return
            }
            const type = task.type == 'Movie' ? 'movie' : 'series'
            needle.get(kitsuEndpoint + '/catalog/' + type + '/kitsu-search-' + type + '/search=' + encodeURIComponent(task.anime_title || task.title) + '.json', { headers }, (err, resp, body) => {
              const meta = ((body || {}).metas || [])[0]
              if (meta) {
                db.map.set(meta.id, animeId)
                mapToKitsu[animeId] = meta.id
                meta.type = 'series'
                metas.push(meta)
              }
              cb()
            })
          }, 1)
          queue.drain = () => {
            cache.metas[url] = metas
            pages[page] = metas.length
            // cache for 2 hours (feed) / 6 hours (search)
            setTimeout(() => {
              delete cache.metas[url]
            }, args.id == 'animepahe-latest' ? 2 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000)
            if (redisKey)
              db.catalog.set(redisKey, page, metas)
            if (!redisMetas)
              resolve({ metas, cacheMaxAge: 2 * 60 * 60 })
          }
          series.forEach(el => { queue.push(el) })
        } else if (!redisMetas)
          reject(new Error('Catalog error: '+JSON.stringify(args)))
      })
    })
  })
})

addon.defineMetaHandler(args => {
  return new Promise((resolve, reject) => {
    needle.get(kitsuEndpoint + '/meta/' + args.type + '/' + args.id.replace('kitsu:', '') + '.json', (err, resp, body) => {
      if (body && body.meta)
        resolve(body)
      else
        reject(new Error('Could not get meta from kitsu api for: '+args.id))
    })
  })
})

function findEpisode(apId, episode, page, cb) {
  // guess page
  const getPage = page || Math.ceil(episode / 30)
  cloudscraper.get({ uri: endpoint + '?m=release&id=' + apId + '&l=30&sort=episode_asc&page=' + getPage, headers }).then((body) => {
    if (typeof body === 'string')
      try {
        body = JSON.parse(body)
      } catch(e) {}
    const episodes = (body || {}).data || []
    let epId
    episodes.some(ep => {
      if (parseInt(ep.episode) == episode) {
        epId = ep.id
        return true
      }
    })

    if (!epId && getPage == 1 && episodes.length == 1)
      epId = episodes[0].id
    if (!epId && !page && getPage != 1 && episodes.length) {
      // guess page again with new found data
      if (episodes[0].episode) {
        const expected = ((getPage -1) * 30) || 1
        if (expected < episodes[0].episode) {
          const difference = parseInt(episodes[0].episode) - expected
          const newPage = Math.ceil((episode - difference) / 30)
          findEpisode(apId, episode, newPage, cb)
          return
        }
      }
    }

    cb(epId)
  })
}

async function getContentMatches(url, regex, headers = {}) {
  return new Promise((resolve, reject) => {
    let body = ''
    needle.get(url, { open_timeout: 9000, headers })
        .on('readable', function() {
          let data = this.read()
          while (data) {
            body = body.concat(data.toString())
            const matches = body.match(regex)
            if (matches) {
              resolve(matches)
              this.destroy()
            }
            data = !matches && this.read()
          }
        })
        .on('done', (err) => {
          // means that promise was not resolved previously so no mirror was found
          reject(err || new Error(`vidstreaming url not available`))
        })
  })
}

async function getStream(url, cb) {
  console.log('get stream: ' + url)
    getContentMatches(url, /<script>eval\((.+)\)\s+<\/script>/s, { referer: 'https://animepahe.com/' })
        .then((matches) => eval('(' + matches[1].trim() + ')'))
        .then((evaled) => evaled.match(/const source='([^']+)'/)[1])
        .then((videoUrl) => {
          cb(videoUrl)
        })
        .catch(e => {
          console.log(e)
          cb()
        })
}

addon.defineStreamHandler(args => {
  return new Promise((resolve, reject) => {
    const id = args.id
    const cacheMaxAge = 0
    db.get(id, cacheMaxAge, cached => {
      if (cached && cached.streams && cached.streams.length) {
        console.log(cached)
        resolve(cached)
        return
      }
      const idParts = id.split(':')
      const kitsuId = 'kitsu:' + idParts[1]
      const episode = idParts.length > 2 ? idParts[idParts.length -1] : 1
      db.map.get(kitsuId, apId => {
        if (apId) {
          findEpisode(apId, episode, null, epId => {
            if (epId) {
              cloudscraper.get({ uri: endpoint + '?m=embed&id=' + epId + '&p=kwik', headers }).then((body) => {
                if (typeof body === 'string')
                  try {
                    body = JSON.parse(body)
                  } catch(e) {}
                const urls = ((body || {}).data || {})[epId] || {}
                if (Object.keys(urls).length) {
                  const streams = []
                  const streamQueue = async.queue((task, cb) => {
                    getStream(task.url, url => {
                      if (url) {
                        const parsedUrl = pUrl(task.originalUrl)
                        streams.push({
                          title: task.title,
                          url: proxy.addProxy(url, { playlist: true, headers: { referer: task.originalUrl, origin: parsedUrl.protocol + '//' + parsedUrl.host, 'user-agent': headers['User-Agent'] }})
                        })
                      }
                      cb()
                    })
                  })
                  streamQueue.drain = () => {
                    db.set(id, streams)
                    resolve({ streams })
                  }
                  for (let key in urls)
                    streamQueue.push({
                      title: (urls[key].disc ? urls[key].disc + ' - ' : '') + key + ' - Stream\nkwik.cx',
                      url: urls[key].url.replace('/e/','/f/'),
                      originalUrl: urls[key].url
                    })
                } else
                  reject(new Error('No sources for id: ' + args.id))
              })
            } else
              reject(new Error('Could not match episode for: ' + args.id))
          })
        } else 
          reject(new Error('Could not get streams for: ' + args.id))
      })
    })
  })
})

module.exports = getRouter(addon.getInterface())

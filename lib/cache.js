
const persist = require('internal').persist

const mapToAp = {}
const streams = {}

function toJson(str) {
	let data
	try {
		data = JSON.parse(str)
	} catch(e) {
		console.error('Redis parse error', e)
	}
	return data
}

module.exports = {
	map: {
		get: (kitsuId, cb) => {
			if (!kitsuId) cb()
			else {
				if (mapToAp[kitsuId]) cb(mapToAp[kitsuId])
				else
					cb(persist.getItem('kitsu-ap-' + kitsuId))
			}
		},
		set: (kitsuId, data) => {
			if (!mapToAp[kitsuId]) {
				mapToAp[kitsuId] = data
				persist.setItem('kitsu-ap-' + kitsuId, data)
			}
		}
	},
	get: (key, cacheMaxAge, cb) => {

		if (streams[key]) {
			cb({ streams: streams[key], cacheMaxAge })
			return
		}

		cb({ streams: persist.getItem(key), cacheMaxAge })

	},
	set: (key, data) => {
		// cache forever
		streams[key] = data
		persist.setItem(key, data)
	},
	genres: {
		set: data => {
			persist.setItem('ap-genres', data)
		},
		get: cb => {
			cb(persist.getItem('ap-genres'))
		}
	},
	catalog: {
		set: (key, page, data) => {
			if (!key) return
			const redisKey = 'ap-catalog-' + key + (page > 1 ? ('-' + page) : '')
			persist.setItem(redisKey, data)
		},
		get: (key, page, cb) => {
			if (!key) {
				cb()
				return
			}
			const redisKey = 'ap-catalog-' + key + (page > 1 ? ('-' + page) : '')
			cb(persist.getItem(redisKey))
		}
	}
}

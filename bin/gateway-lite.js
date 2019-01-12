#!/usr/bin/env node

const basicAuth = require('express-basic-auth')
const chokidar = require('chokidar')
const credential = require('credential')
const dashdash = require('dashdash')
const debug = require('debug')('gateway-lite')
const express = require('express')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const wsProxy = require('http-proxy-middleware')
const cascadeProxy = require('express-http-proxy')
const schedule = require('node-schedule')
const shell = require('shelljs')
const tls = require('tls')
const vhost = require('vhost')
const yaml = require('js-yaml')
const { promisify } = require('util')

process.on('SIGINT', function () {
  console.log('Received SIGINT. Exiting ...')
  process.exit()
})

process.on('SIGTERM', function () {
  console.log('Received SIGTERM. Exiting ...')
  process.exit()
})

const cwd = process.cwd()
const pw = credential({ work: 0.1 })
const verifyAsync = promisify(pw.verify)

const command = (args) => {
  const options = [
    {
      name: 'domain',
      type: 'string',
      help: 'Base path to the all the domain directories',
      helpArg: 'DIR'
    },
    {
      name: 'key',
      type: 'string',
      help: 'Path to the HTTPS private key',
      helpArg: 'PATH'
    },
    {
      name: 'cert',
      type: 'string',
      help: 'Path to the HTTPS certificate',
      helpArg: 'PATH'
    },
    {
      name: 'port',
      type: 'string',
      help: 'Port for HTTP, defaults to 80',
      helpArg: 'PORT'
    },
    {
      name: 'https-port',
      type: 'string',
      help: 'Port for HTTPS, defaults to 443',
      helpArg: 'PORT'
    },
    {
      name: 'email',
      type: 'string',
      help: `An email that has agreed to the Let's Encrypt terms and is used for the Let's Encrypt account`,
      helpArg: 'EMAIL'
    },
    {
      name: 'lets-encrypt',
      type: 'bool',
      help: `Use Let's Encrypt to create missing certificates, and renew older Let's Encrypt certificates before expiry`,
      default: false
    },
    {
      name: 'staging',
      type: 'bool',
      help: `Use the Let's Encrypt staging server`,
      default: false
    },
    {
      name: 'proxy',
      type: 'string',
      help: `Proxy sepc`,
      helpArg: 'SPEC',
      default: '{}'
    },
    {
      name: 'redirect',
      type: 'string',
      help: `Redirect sepc`,
      helpArg: 'SPEC',
      default: '{}'
    },
    {
      name: 'user',
      type: 'string',
      help: `User sepc`,
      helpArg: 'SPEC',
      default: '{}'
    },
    {
      name: 'pwa',
      type: 'string',
      help: `Progressive web app sepc`,
      helpArg: 'SPEC',
      default: '{}'
    }
  ]

  const parser = dashdash.createParser({options: options})
  let opts
  try {
    opts = parser.parse(args)
  } catch (e) {
    console.error('gateway-lite: error: %s', e.message)
    process.exit(1)
  }

  if (opts.help) {
    const help = parser.help({includeEnv: true}).trimRight()
    console.log('usage: gateway-lite [OPTIONS]\n' + 'options:\n' + help)
    process.exit(0)
  }

  const program = opts
  program.letsEncrypt = opts.lets_encrypt
  program.httpsPort = opts.https_port

  // console.log('cmd:', program)
  // console.log('args:', opts._args)

  const port = program.port || 80
  const httpOptions = {port}
  const domainDir = program.domain || 'domain'
  const proxy = yaml.safeLoad(program.proxy)
  const user = yaml.safeLoad(program.user)
  const redirect = yaml.safeLoad(program.redirect)
  const pwa = yaml.safeLoad(program.pwa)
  debug('PROXY', proxy)
  debug('user', user)
  debug('redirect', redirect)
  debug('pwa', pwa)
  let httpsOptions
  if (program.httpsPort || program.key || program.cert) {
    const httpsPort = program.httpsPort || 443
    const msg = `Configured for HTTPS on ${httpsPort}.`
    console.log(msg)
    debug(msg)
    httpsOptions = {pwa, key: program.key, cert: program.cert, httpsPort, proxy, user, redirect}
  } else {
    const msg = 'No HTTPS options specified so not serving on HTTPS port'
    console.log(msg)
    debug(msg)
  }
  const staging = program.statging || false
  if (staging) {
    debug('Let\'s encrypt staging mode')
  } else {
    debug('Let\'s encrypt live mode')
  }
  const email = program.email
  const letsEncrypt = program.letsEncrypt || false
  if (letsEncrypt && !email) {
    throw new Error('Please use --email when using --lets-encrypt')
  }
  return {email, letsEncrypt, staging, httpOptions, httpsOptions, domainDir}
}

const makeRedirectorHandler = (httpOptions, httpsOptions) => {
  return (req, res, next) => {
    const bareDomain = (req.hostname.split('.').length === 2)
    debug(req.hostname, '-> Bare domain:', bareDomain, '; Protocol:', req.protocol)
    if (bareDomain || (req.protocol !== 'https')) {
      let hostname = req.hostname
      if (bareDomain) {
        hostname = `www.${hostname}`
      }
      let url
      let httpsPort = 443
      if (httpsOptions) {
        httpsPort = httpsOptions.httpsPort
      }
      url = `https://${hostname}`
      if (httpsPort + '' !== '443') {
        debug('HTTPS port is not 443, it is', httpsPort, 'so we need to add that to the hostname')
        url += `:${httpsPort}`
      }
      url += `${req.url}`
      debug('Redirecting to URL:', url)
      res.redirect(url)
    } else {
      debug('No http->https or bare-domain->www redirection needed')
      next()
    }
  }
}

async function domainApp (domainDir, domain, httpOptions, httpsOptions) {
  let redirects = {}
  let proxyPaths = []
  let users = {}
  let pwa = {}
  try {
    const redirectsFile = path.join(domainDir, domain, 'redirects.json')
    try {
      if (fs.existsSync(redirectsFile)) {
        redirects = yaml.safeLoad(fs.readFileSync(redirectsFile))
      }
    } catch (e) {
      debug('  Error:', e)
    }
    redirects = Object.assign({}, redirects, httpsOptions.redirect[domain] || {})
    debug(domain, redirects)

    const proxyFile = path.join(domainDir, domain, 'proxy.json')
    try {
      if (fs.existsSync(proxyFile)) {
        proxyPaths = yaml.safeLoad(fs.readFileSync(proxyFile))
      }
    } catch (e) {
      debug('  Error:', e)
    }
    const p = httpsOptions.proxy[domain] || []
    for (let i = 0; i < p.length; i++) {
      proxyPaths.push(p[i])
    }
    debug(domain, proxyPaths)

    const pwaFile = path.join(domainDir, domain, 'pwa.json')
    try {
      if (fs.existsSync(pwaFile)) {
        pwa = yaml.safeLoad(fs.readFileSync(pwaFile))
      }
    } catch (e) {
      debug('  Error:', e)
    }
    pwa = Object.assign({}, pwa, httpsOptions.pwa[domain] || {})
    debug(domain, Object.keys(pwa).length ? 'PWA enabled' : 'No PWA')

    const usersFile = path.join(domainDir, domain, 'users.json')
    try {
      if (fs.existsSync(usersFile)) {
        users = yaml.safeLoad(fs.readFileSync(usersFile))
      }
    } catch (e) {
      debug('  Error:', e)
    }
    users = Object.assign({}, users, httpsOptions.user[domain] || {})
    debug(domain, users)
  } catch (e) {
    debug(e)
    console.error(e)
  }

  const app = express()

  app.disable('x-powered-by')
  // This is to redirect to https://www.
  app.use(makeRedirectorHandler(httpOptions, httpsOptions))
  debug('  Set up redirectorHandler')

  if (Object.keys(redirects).length) {
    // If nothing has been matched, check the redirects and redirect the URL, keeping the query string.
    app.get('*', (req, res, next) => {
      const target = redirects[req._parsedUrl.pathname]
      if (!target) {
        return next()
      }
      res.setHeader('Location', req.url.replace(req._parsedUrl.pathname, target))
      res.status(302).send('Redirecting ...')
    })
    debug(`  Set up ${Object.keys(redirects).length} redirect(s)`)
    for (let name of Object.keys(redirects)) {
      if (!name.startsWith('/')) {
        throw new Error(`Invalid path '${name}'. Expected redirect paths to start with a /.`)
      }
      debug(`    ${name} -> ${redirects[name]}`)
    }
  }

  const { manifestUrl = '/public/theme/manifest.json', serviceWorkerUrl = '/sw.js', name = 'App', shortName = 'app', display = 'standalone', startUrl = '/start', offlineUrl = '/offline', urlsToCache = [], backgroundColor = 'white', themeColor = '#000000', version = '0.1.0', defaultLocale = 'en', description = 'App', icon192Url = '/public/theme/icon192.png', icon192File = './icon192.png', icon512Url = '/public/theme/icon512.png', icon512File = './icon512.png' } = pwa
  if (Object.keys(pwa).length) {
    debug(`  Setting up service worker URL at ${serviceWorkerUrl}.`)
    app.get(serviceWorkerUrl, async (req, res, next) => {
      try {
        const lookup = {startUrl, offlineUrl, icon512Url, icon192Url, manifestUrl}
        const filesToCache = [startUrl, offlineUrl, icon512Url, icon192Url, manifestUrl]
        for (let i = 0; i < urlsToCache.length; i++) {
          filesToCache.push(urlsToCache[i][0])
          lookup[urlsToCache[i][0]] = urlsToCache[i][0]
          for (let j = 0; j < urlsToCache[i].length; j++) {
            lookup[urlsToCache[i][j]] = urlsToCache[i][0]
          }
        }
        // debug(filesToCache)
        // debug(lookup)
        res.type('application/javascript')
        res.send(`// 2019-01-10, manifest version: ${version}
var filesToCache = ${JSON.stringify(filesToCache)};
var lookup = ${JSON.stringify(lookup)};

self.addEventListener('install', function(event) {
  var promises = [];
  filesToCache.forEach(function(fileToCache) {
    var offlineRequest = new Request(fileToCache);
    console.log('Preparing fetch for', fileToCache);
    promises.push(
      fetch(offlineRequest).then(function(response) {
        return caches.open('offline').then(function(cache) {
          console.log('[oninstall] Cached offline page', response.url, response.status);
          var r = cache.put(offlineRequest, response);
          r.then(function(t) {
            console.log('Fetched', t)
          })
          return r
        });
      })
    )
  })
  event.waitUntil(Promise.all(promises).then(function(success) { self.skipWaiting() ; console.log('Finished populating the cache. Ready.'); return success }));
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    fetch(event.request)
    .catch(function (error) {
      return caches.open('offline')
      .then(function(cache) {
        var url = new URL(event.request.url)
        var path = url.pathname
        console.log('Investigating "' + path + '" found "'+ lookup[path] +'" from cache ...')
        if (lookup[path]) {
          console.log('Returning path "' + lookup[path] + '" for "'+ path +'" from cache ...')
          return cache.match(lookup[path])
        } else {
          console.log('Returning "${offlineUrl}" for path "' + path + '" since it is not in the cache ...')
          return cache.match('${offlineUrl}').then(function(r) {console.log(r); return r}).catch(function(e) {console.log(e)})
        }
      })
    })
  );
});
      `)
      } catch (e) {
        next(e)
      }
    })

// var uniqueFilesToCache = [];
// self.addEventListener('install', function(event) {
//   // event.waitUntil(self.skipWaiting())
//   var promises = [];
//   filesToCache.forEach(function(fileToCache) {
//     var offlineRequest = new Request(fileToCache[0]);
//     console.log('Preparing fetch for', fileToCache[0]);
//     promises.push(
//       fetch(offlineRequest).then(function(response) {
//         return caches.open('offline').then(function(cache) {
//           const p = []
//           var r = cache.put(offlineRequest, response).then(function(t) {
//             console.log('Fetched', t)
//           })
//           p.push(r)
//           fileToCache.slice(1, fileToCache.length).forEach(function(duplicate) {
//             console.log('Preparing fetch for duplicate', fileToCache[0]);
//             uniqueFilesToCache.push(duplicate)
//             var fileOfflineRequest = new Request(duplicate);
//             console.log('[oninstall] Cached offline page', response.url, 'as', duplicate);
//             var r = cache.put(fileOfflineRequest, response).then(function(t) {
//               console.log('Fetched', t)
//             })
//             p.push(r)
//           })
//           return Promise.all(p).then(function(all) { return all[0] })
//         });
//       })
//     )
//   })
//   event.waitUntil(Promise.all(promises).then(function(success) { self.skipWaiting() ; console.log('Finished populating the cache. Ready.'); return success }));
// });

    debug(`  Setting up manifest at ${manifestUrl}.`)
    app.get(manifestUrl, async (req, res, next) => {
      try {
        res.type('application/json')
        res.json({
          'manifest_version': 2,
          name,
          display,
          start_url: startUrl,
          background_color: backgroundColor,
          theme_color: themeColor,
          short_name: shortName,
          version,
          default_locale: defaultLocale,
          description,
          icons: [
            {
              src: icon192Url,
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: icon512Url,
              sizes: '512x512',
              type: 'image/png'
            }
          ]
        })
      } catch (e) {
        next(e)
      }
    })
    const absIcon192File = path.normalize(path.join(process.cwd(), domainDir, domain, icon192File))
    debug(`  Setting up ${icon192Url} -> ${absIcon192File} serve correctly`)
    app.get(icon192Url, (req, res, next) => {
      res.sendFile(absIcon192File)
    })
    const absIcon512File = path.normalize(path.join(process.cwd(), domainDir, domain, icon512File))
    debug(`  Setting up ${icon512Url} -> ${absIcon512File} serve correctly`)
    app.get(icon512Url, (req, res, next) => {
      res.sendFile(absIcon512File)
    })
  }

  if (proxyPaths.length) {
    // We'll have this last because it will redirect /something to /something/ if it can't be found.
    // this can mess with the behaviour above
    debug(`  Setting up ${proxyPaths.length} proxy path(s)`)
    for (let i = 0; i < proxyPaths.length; i++) {
      let [reqPath, downstream, options] = proxyPaths[i]
      let path = '/'
      const parts = downstream.split('/')
      if (parts.length > 0) {
        path = '/' + parts.slice(1, parts.length).join('/')
        downstream = parts[0]
      }
      debug('   ', reqPath, downstream, path, options)
      if (proxyPaths[i].length > 3) {
        throw new Error('Too many items in the array for downstream server ' + proxyPaths[i])
      }
      let {auth = false, limit, cascade = false, ws = false, ...rest} = options || {}
      if (Object.keys(rest).length) {
        throw new Error('Unexpected extra options: ' + Object.keys(rest).join(', '), 'for downstream server ' + proxyPaths[i])
      }
      if (ws && cascade) {
        throw new Error(`Cannot use 'cascade' with 'ws=true'`)
      }
      if (ws && limit) {
        throw new Error(`Cannot use 'limit' with 'ws=true'`)
      }
      if (typeof limit === 'undefined') {
        limit = '500mb'
      }
      if (auth) {
        debug(`    Set up ${Object.keys(users).length} auth user(s)`)
        // app.use(reqPath, basicAuth({users, challenge: true}))
        const lowerCaseUsers = {}
        for (let username in users) {
          if (users.hasOwnProperty(username)) {
            lowerCaseUsers[username.toLowerCase()] = users[username]
          }
        }
        app.use(reqPath, basicAuth({ authorizeAsync: true,
          challenge: true,
          authorizer: (username, password, cb) => {
            const lowerCaseUsername = username.toLowerCase()
            const hashOrPassword = lowerCaseUsers[lowerCaseUsername]
            if (!hashOrPassword) {
              cb(null, false)
            } else if (hashOrPassword.length <= 64) {
              debug('Using a password check')
              cb(null, hashOrPassword === password)
            } else {
              debug('Using a hash check')
              const decoded = Buffer.from(hashOrPassword, 'base64').toString('ascii')
              verifyAsync(decoded, password)
              .then(isValid => {
                cb(null, isValid)
              })
              .catch(e => {
                debug(e)
                cb(e, null)
              })
            }
          }
        }))
      }
      if (ws) {
        const pathRewrite = {}
        pathRewrite['^' + reqPath] = path
        const proxyOpts = {
          ws: true,
          target: 'http://' + downstream,
          pathRewrite,
          // proxyTimeout: timeout,
          // timeout: timeout,
          onProxyReq: (proxyReq, req, res) => {
            const ip = req.ip.split(':')[3]
            debug('From', ip, 'using protocol:', req.protocol)
            if (ip) {
              proxyReq.setHeader('X-Real-IP', ip)
              proxyReq.setHeader('X-Forwarded-For', ip)
            }
            proxyReq.setHeader('X-Forwarded-Proto', req.protocol)
            debug('>>>', domain + reqPath, '->', downstream + path, req.originalUrl)
          },
          onError: (err, req, res) => {
            switch (err && err.code) {
              case 'ECONNRESET': { debug(err); return res.status(405).json({error: '405'}) }
              case 'ECONNREFUSED': { debug(err); return res.status(504).json({error: '504'}) }
              default: { debug(err); return res.status(500).json({error: '500'}) }
            }
          }
        }
        // Has to come last, it doesn't support next()
        app.use(reqPath, wsProxy(proxyOpts))
      } else {
        const proxyOpts = {
          limit: limit,
          // userResDecorator: function(proxyRes, proxyResData, userReq, userRes) {
          //   debug(proxyResData)
          //   return proxyResData;
          // },
          parseReqBody: false,
          preserveHostHdr: true,
          https: false,
          proxyReqPathResolver: function (req) {
            let target = req.originalUrl
            if (path) {
              target = path + req.originalUrl.slice(reqPath.length, req.originalUrl.length)
            }
            debug('>>>', reqPath, domain + req.originalUrl, '->', downstream + target)
            return target
          },
          proxyReqOptDecorator: function (proxyReqOpts, req) {
            const ip = req.ip.split(':')[3]
            debug('From', ip, 'using protocol:', req.protocol)
            if (ip) {
              proxyReqOpts.headers['X-Real-IP'] = ip
              proxyReqOpts.headers['X-Forwarded-For'] = ip
            }
            proxyReqOpts.headers['X-Forwarded-Proto'] = req.protocol
            return proxyReqOpts
          },
          proxyErrorHandler: function (err, res, next) {
            switch (err && err.code) {
              case 'ECONNRESET': { debug(err); return res.status(405).json({error: '405'}) }
              case 'ECONNREFUSED': { debug(err); return res.status(504).json({error: '504'}) }
              default: { next(err) }
            }
          },
          timeout: 2 * 60 * 1000
        }
        const middleware = []
        if (cascade) {
          // Strange bug in express-http-proxy that requires this set up to prevent the cascade continuing after this one has returned a 200 OK
          middleware.push(
            (req, res, next) => {
              debug('Cascade triggered')
            }
          )
          proxyOpts.skipToNextHandlerFilter = function (proxyRes) {
            debug(`    Got response code ${proxyRes.statusCode} form ${domain} with cascade ${cascade}.`)
            if (!cascade) {
              return false
            }
            const decision = proxyRes.statusCode === 404
            debug(`    Skipping: ${decision}`)
            return decision
          }
        }
        app.use(reqPath, cascadeProxy(downstream, proxyOpts), ...middleware)
      }
      debug('    Set up', proxyPaths[i][0], '->', proxyPaths[i][1])
    }
  } else {
    app.use(function (req, res, next) {
      res.status(404).json({error: `No proxy.json set up for ${domain}`})
    })
    debug('  Set up 404 handler to warn of no proxy.json file')
  }
  return app
}

function getRandomInt (max) {
  return Math.floor(Math.random() * Math.floor(max))
}

async function main () {
  const {letsEncrypt, email, staging, httpOptions, httpsOptions, domainDir} = command(process.argv)

  const dirs = []
  const possDirs = fs.readdirSync(domainDir)
  for (let i = 0; i < possDirs.length; i++) {
    const stat = fs.statSync(path.join(domainDir, possDirs[i]))
    if (stat && stat.isDirectory()) {
      dirs.push(possDirs[i])
    }
  }

  if (letsEncrypt) {
    // const help = `
    // (*)   *    *    *    *    *
    //  ┬    ┬    ┬    ┬    ┬    ┬
    //  │    │    │    │    │    │
    //  │    │    │    │    │    └ day of week (0 - 7) (0 or 7 is Sun)
    //  │    │    │    │    └───── month (1 - 12)
    //  │    │    │    └────────── day of month (1 - 31)
    //  │    │    └─────────────── hour (0 - 23)
    //  │    └──────────────────── minute (0 - 59)
    //  └───────────────────────── second (0 - 59, OPTIONAL)
    // `
    // console.log(help)
    // let j = schedule.scheduleJob('42 * * * * *', function(){

    schedule.scheduleJob('0 */12 * * *', function () {
      const wait = getRandomInt(12 * 60 * 60)
      console.log(`Attempting certificate renewal in ${wait} seconds (so on average twice per day with a lot of variation) ...`)
      setTimeout(
        () => {
          shell.exec('certbot -q renew', function (code, stdout, stderr) {
            console.log('Exit code:', code)
            console.log('Program output:', stdout)
            console.log('Program stderr:', stderr)
            if (code !== 0) {
              shell.echo('Error: Failed to renew certificates')
            }
          })
        },
        wait * 1000
      )
    })

    const httpApp = express()
    for (let d = 0; d < dirs.length; d++) {
      const domain = dirs[d]
      const vhostApp = express()
      vhostApp.disable('x-powered-by')
      const webrootStaticDir = path.join(domainDir, domain, 'webroot')
      const wellKnown = path.join(webrootStaticDir, '.well-known')
      vhostApp.use('/.well-known', express.static(wellKnown))
      debug('  Serving /.well-known from', wellKnown)
      // This is to redirect to https://www.
      vhostApp.use(makeRedirectorHandler(httpOptions, httpsOptions))
      debug('  Set up redirectorHandler')
      httpApp.use(vhost(domain, vhostApp))
    }

    // Must be after other routes - Handle 404
    httpApp.get('*', (req, res) => {
      res.status(404).json({error: '404'})
    })

    // Error handler has to be last
    httpApp.use(function (err, req, res, next) {
      debug('Error:', err)
      res.status(500).json({error: '500'})
    })

    http.createServer(httpApp).listen(httpOptions.port, (error) => {
      if (error) {
        debug('Error:', error)
        return process.exit(1)
      } else {
        debug(`Listening for HTTP requests on port ${httpOptions.port}`)
      }
    })

    chokidar.watch(domainDir).on('change', async (event, path) => {
      const msg = 'Changed files, could really do with reload. ...'
      console.log(msg)
      debug(msg)
    })
  } else {
    const httpApp = express()
    for (let d = 0; d < dirs.length; d++) {
      const domain = dirs[d]
      const vhostApp = express()
      vhostApp.disable('x-powered-by')
      // This is to redirect to https://www.
      vhostApp.use(makeRedirectorHandler(httpOptions, httpsOptions))
      debug('  Set up redirectorHandler')
      httpApp.use(vhost(domain, vhostApp))
    }

    // Must be after other routes - Handle 404
    httpApp.get('*', (req, res) => {
      res.status(404).json({error: '404'})
    })

    // Error handler has to be last
    httpApp.use(function (err, req, res, next) {
      debug('Error:', err)
      res.status(500).json({error: '500'})
    })

    http.createServer(httpApp).listen(httpOptions.port, (error) => {
      if (error) {
        debug('Error:', error)
        return process.exit(1)
      } else {
        debug(`Listening for HTTP requests on port ${httpOptions.port}`)
      }
    })
  }

  const secureContext = {}
  const app = express()
  for (let d = 0; d < dirs.length; d++) {
    const domain = dirs[d]
    if (domain === 'localhost') {
      debug('Skipping domain', domain)
      continue
    }
    debug('Adding domain', domain)
    shell.mkdir('-p', path.join(domainDir, domain, 'sni'))
    const certs = shell.ls(path.join(domainDir, domain, 'sni', '*.pem'))
    debug('  ' + certs.length + ' certificates found')
    if (certs.length < 2) {
      if (letsEncrypt) {
        let fixed = false
        shell.cp(`/etc/letsencrypt/live/${domain}/fullchain.pem`, path.join(domainDir, domain, 'sni', 'cert.pem'))
        if (shell.error()) {
          debug('Could not copy', `/etc/letsencrypt/live/${domain}/fullchain.pem`)
        } else {
          shell.cp(`/etc/letsencrypt/live/${domain}/privkey.pem`, path.join(domainDir, domain, 'sni', 'key.pem'))
          if (shell.error()) {
            debug('Could not copy', `/etc/letsencrypt/live/${domain}/provkey.pem`)
          } else {
            fixed = true
          }
        }
        if (fixed) {
          let msg = `Added an exiting set of certificates for ${domain}.`
          debug(msg)
          console.log(msg)
        }
        if (!fixed) {
          try {
            fixed = await new Promise((resolve, reject) => {
              debug('  Attempting to get a Let\'s Encrypt certificate for', domain)
              const webroot = path.join(domainDir, domain, 'webroot')
              shell.mkdir('-p', webroot)
              const sni = path.join(domainDir, domain, 'sni')
              shell.mkdir('-p', sni)
              let cmd = `certbot certonly --webroot -w "${webroot}" -d "${domain}" -n -m "${email}" --agree-tos`
              if (staging) {
                cmd += ' --staging'
              }
              debug('  ' + cmd)
              shell.exec(cmd, {async: true, stdio: 'inherit'}, function (code, stdout, stderr) {
                if (code !== 0) {
                  console.log('  Failed to get certificate for', domain)
                  debug('  Failed to get certificate for', domain)
                  reject(new Error('Failed to get certificate for ' + domain))
                } else {
                  debug('  Got new certificate for ' + domain)
                  shell.cp(`/etc/letsencrypt/live/${domain}/fullchain.pem`, path.join(sni, 'cert.pem'))
                  if (shell.error()) {
                    let msg = `Could not copy '/etc/letsencrypt/live/${domain}/fullchain.pem'`
                    debug(msg)
                    reject(new Error(msg))
                  } else {
                    shell.cp(`/etc/letsencrypt/live/${domain}/privkey.pem`, path.join(sni, 'key.pem'))
                    if (shell.error()) {
                      let msg = `Could not copy '/etc/letsencrypt/live/${domain}/privkey.pem'`
                      debug(msg)
                      reject(msg)
                    } else {
                      resolve(true)
                    }
                  }
                }
              })
            })
            if (fixed === true) {
              let msg = `Added an exiting set of certificates for ${domain}.`
              debug(msg)
              console.log(msg)
            }
          } catch (e) {
            console.log(e)
          }
        }
      }
    }

    debug('Checking https options ...')
    if (httpsOptions) {
      try {
        const sniDir = path.join(domainDir, domain, 'sni')
        const statSni = fs.statSync(sniDir)
        if (statSni && statSni.isDirectory()) {
          const statKey = fs.statSync(path.join(sniDir, 'key.pem'))
          const statCert = fs.statSync(path.join(sniDir, 'cert.pem'))
          if (statKey && statCert) {
            secureContext[domain] = tls.createSecureContext({
              key: fs.readFileSync(path.join(sniDir, 'key.pem'), 'utf8'),
              cert: fs.readFileSync(path.join(sniDir, 'cert.pem'), 'utf8')
            })
          }
        }
      } catch (e) {
        debug('Could not load certificates for domain', domain, e)
      }
      debug('Setting up virtual hosts ...')
      const vhostApp = await domainApp(domainDir, domain, httpOptions, httpsOptions)
      app.use(vhost(domain, vhostApp))
    }
  }

  // Must be after other routes - Handle 404
  app.get('*', (req, res) => {
    res.status(404).json({error: '404'})
  })

  // Error handler has to be last
  app.use(function (err, req, res, next) {
    debug('Error:', err)
    res.status(500).json({error: '500'})
  })

  if (httpsOptions) {
    let key, cert
    try {
      key = fs.readFileSync(httpsOptions.key || path.join(cwd, 'private.key'), {encoding: 'utf8'})
      cert = fs.readFileSync(httpsOptions.cert || path.join(cwd, 'certificate.pem'), {encoding: 'utf8'})
    } catch (e) {
      debug(e)
      console.error('Could not load SSL certficates.')
      process.exit(1)
    }
    const options = {
      SNICallback: function (domain, cb) {
        debug('Secure context requested for', domain)
        if (secureContext[domain]) {
          if (cb) {
            debug('calling back with', domain)
            cb(null, secureContext[domain])
          } else {
            // compatibility for older versions of node
            return secureContext[domain]
          }
        } else {
          const msg = 'No keys/certificates for domain requested'
          debug(msg)
          cb(new Error(msg), null)
        }
      },
      // Must list a default key and cert because required by tls.createServer()
      key,
      cert
    }
    try {
      https
      .createServer(options, app)
      .listen(httpsOptions.httpsPort, (error) => {
        if (error) {
          debug('Error:', error)
          return process.exit(1)
        } else {
          debug(`Listening for HTTPS requests on port ${httpsOptions.httpsPort}`)
        }
      })
    } catch (e) {
      debug(`Could not serve HTTPS on port ${httpOptions.httpsPort}`, e)
    }
  }
}

main()

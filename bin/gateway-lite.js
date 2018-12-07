const Command = require('commander').Command
const basicAuth = require('express-basic-auth')
const debug = require('debug')('gateway-lite')
const express = require('express')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const proxy = require('express-http-proxy')
// const spdy = require('spdy')
const tls = require('tls')
const vhost = require('vhost')

const cwd = process.cwd()

const command = (args) => {
  const program = new Command()
  program
  .version('0.1.0')
  .option('--domain [dir]', `Base path to the all the domain directories`)
  .option('--key [path]', 'Path to the HTTPS private key, defaults to private.key in the current directory')
  .option('--cert [path]', 'Path to the HTTPS certificate, defaults to certificate.pem in the current directory')
  .option('--dhparam [path]', 'Path to the DH Params file')
  .option('--port [port]', 'Port for HTTP, defaults to 80')
  .option('--https-port [port]', 'Port for HTTPS, defaults to 443')
  program.parse(args)
  const port = program.port || 80
  const httpOptions = {port}
  const domainDir = program.domain || 'domain'
  let httpsOptions
  if (program.httpsPort || program.key || program.cert || program.dhparam) {
    try {
      const key = fs.readFileSync(program.key || path.join(cwd, 'private.key'), {encoding: 'utf8'})
      const cert = fs.readFileSync(program.cert || path.join(cwd, 'certificate.pem'), {encoding: 'utf8'})
      let dhparam
      if (program.dhparam) {
        dhparam = fs.readFileSync(program.dhparam, {encoding: 'utf8'})
      }
      const httpsPort = program.httpsPort || 443
      httpsOptions = {key, cert, dhparam, httpsPort}
    } catch (e) {
      const msg = 'WARNING: Not using HTTPS, could not set up the options.'
      console.error(msg, 'See DEBUG=gateway-lite log for more details')
      debug(e)
      debug(msg)
    }
  } else {
    const msg = 'No HTTPS options specified so not serving on HTTPS port'
    console.log(msg)
    debug(msg)
  }
  return {httpOptions, httpsOptions, domainDir}
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
      debug('No redirection needed')
      next()
    }
  }
}

async function domainApp (domainDir, domain, httpOptions, httpsOptions) {
  const webrootStaticDir = path.join(domainDir, domain, 'webroot')
  const redirectsFile = path.join(domainDir, domain, 'redirects.json')

  let redirects = {}
  try {
    if (fs.existsSync(redirectsFile)) {
      redirects = JSON.parse(fs.readFileSync(redirectsFile))
    }
  } catch (e) {
    debug('  Error:', e)
  }

  const proxyFile = path.join(domainDir, domain, 'proxy.json')
  let proxyPaths = []
  try {
    if (fs.existsSync(proxyFile)) {
      proxyPaths = JSON.parse(fs.readFileSync(proxyFile))
    }
  } catch (e) {
    debug('  Error:', e)
  }

  const usersFile = path.join(domainDir, domain, 'users.json')
  let users = {}
  try {
    if (fs.existsSync(usersFile)) {
      users = JSON.parse(fs.readFileSync(usersFile))
    }
  } catch (e) {
    debug('  Error:', e)
  }

  const app = express()

  app.disable('x-powered-by')
  const wellKnown = path.join(webrootStaticDir, '.well-known')
  app.use('/.well-known', express.static(wellKnown))
  debug('  Serving /.well-known from', wellKnown)
  // This is to redirect to https://www.
  app.use(makeRedirectorHandler(httpOptions, httpsOptions))
  debug('  Set up redirectorHandler')

  if (Object.keys(redirects).length) {
    // If nothing has been matched, check the redirects and redirect the URL, keeping the query string.
    app.get('*', async (req, res, next) => {
      const target = redirects[req._parsedUrl.pathname]
      if (!target) {
        return next()
      }
      res.setHeader('Location', req.url.replace(req._parsedUrl.pathname, target))
      res.status(302).send('Redirecting ...')
    })
    debug(`  Set up ${Object.keys(redirects).length} redirect(s)`)
  }

  // if (Object.keys(users).length) {
  //   const o = {users, challenge: true}
  //   app.use(basicAuth(o))
  //   debug(`  Set up ${Object.keys(users).length} auth user(s)`)
  // }

  if (proxyPaths.length) {
    // We'll have this last because it will redirect /something to /something/ if it can't be found.
    // this can mess with the behaviour above
    debug(`  Setting up ${proxyPaths.length} proxy path(s)`)
    for (let i = 0; i < proxyPaths.length; i++) {
      const [reqPath, downstream, options] = proxyPaths[i]
      debug('   ', reqPath, downstream, options)
      if (proxyPaths[i].length > 3) {
        throw new Error('Too many items in the array for downstream server ' + proxyPaths[i])
      }
      const {auth = false, limit = '500mb', path, ...rest} = options || {}
      if (Object.keys(rest).length) {
        throw new Error('Unexpected extra options: ' + Object.keys({ rest }).join(', '), 'for downstream server ' + proxyPaths[i])
      }
      if (auth) {
        debug(`    Set up ${Object.keys(users).length} auth user(s)`)
        app.use(reqPath, basicAuth({users, challenge: true}))
      }
      app.use(reqPath, proxy(downstream, {
        limit: limit,
        // userResDecorator: function(proxyRes, proxyResData, userReq, userRes) {
        //   // debug(proxyRes)
        //   debug(proxyResData)
        //   // debug(userReq)
        //   // debug(userRes)
        //   // proxyReqOpts.headers['Docker-Distribution-Api-Version'] = 'registry/2.0'
        //   return proxyResData;
        // },
        parseReqBody: false,
        preserveHostHdr: true,
        https: false,
        proxyReqPathResolver: function (req) {
          if (path) {
            const target = path + req.originalUrl.slice(reqPath.length, req.originalUrl.length)
            debug('>>>', req.originalUrl, reqPath, target)
            return target
          }
          debug('>>>', req.originalUrl)
          return req.originalUrl
        },
        proxyReqOptDecorator: function (proxyReqOpts, req) {
          const ip = req.ip.split(':')[3] // (req.connection.remoteAddress || '').split(',')[0].trim()
          debug(ip, req.protocol)
          proxyReqOpts.headers['X-Real-IP'] = ip
          proxyReqOpts.headers['X-Forwarded-For'] = ip
          proxyReqOpts.headers['X-Forwarded-Proto'] = req.protocol
          return proxyReqOpts
        } // ,
        // timeout: 2000
      }))
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

async function main () {
  // const {key, cert, dhparam, port, httpsPort, domainDir} =
  const {httpOptions, httpsOptions, domainDir} = command(process.argv)
  const dirs = fs.readdirSync(domainDir)
  const secureContext = {}
  const app = express()
  for (let d = 0; d < dirs.length; d++) {
    const domain = dirs[d]
    debug('Adding domain', domain)
    if (httpsOptions) {
      const stat = fs.statSync(path.join(domainDir, domain))
      if (stat && stat.isDirectory()) {
        const sniDir = path.join(domainDir, domain, 'sni')
        secureContext[domain] = tls.createSecureContext({
          key: fs.readFileSync(path.join(sniDir, 'key.pem'), 'utf8'),
          cert: fs.readFileSync(path.join(sniDir, 'cert.pem'), 'utf8')
          // ca: fs.readFileSync('./path_to_certificate_authority_bundle.ca-bundle1', 'utf8'), // this ca property is optional
        })
        // Instead of this you should create a symlink explicitly to support www. and other sub-domains
        // secureContext[domain.slice(4)] = secureContext[domain]
      }
    }
    const vhostApp = await domainApp(domainDir, domain, httpOptions, httpsOptions)
    app.use(vhost(domain, vhostApp))
    // Instead of this you should create a symlink explicitly to support www. and other sub-domains
    // app.use(vhost(domain.slice(4), vhostApp))
  }

  http.createServer(app).listen(httpOptions.port, (error) => {
    if (error) {
      debug('Error:', error)
      return process.exit(1)
    } else {
      debug(`Listening for HTTP requests on port ${httpOptions.port}`)
    }
  })

  if (httpsOptions) {
    const {key, cert, dhparam} = httpsOptions
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
          throw new Error('No keys/certificates for domain requested')
        }
      },
      // must list a default key and cert because required by tls.createServer()
      key,
      cert,
      dhparam
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
      // debug(options)
      // internal/stream_base_commons.js:62 var err = req.handle.writev(req, chunks, allBuffers);
      // spdy
      // .createServer(options, app)
      // .listen(httpsPort, (error) => {
      //   if (error) {
      //     debug('Error:', error)
      //     return process.exit(1)
      //   } else {
      //     debug(`Listening for HTTPS and HTTP 2 requests on port ${httpsPort}`)
      //   }
      // })
    } catch (e) {
      debug(`Could not serve HTTPS on port ${httpOptions.httpsPort}`, e)
    }
  }
}

main()

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

const command = (args, options) => {
  const {addExtraOptions, processResult} = options || {}
  const program = new Command()
  program
  .version('0.1.0')
  .option('--key [path]', 'Path to the HTTPS private key, defaults to private.key in the current directory')
  .option('--cert [path]', 'Path to the HTTPS certificate, defaults to certificate.pem in the current directory')
  .option('--dhparam [path]', 'Path to the DH Params file')
  .option('--port [port]', 'Port for HTTP, defaults to 80')
  .option('--https-port [port]', 'Port for HTTPS, defaults to 443')
  if (addExtraOptions) {
    addExtraOptions(program)
  }
  program.parse(args)

  const key = fs.readFileSync(program.key || path.join(cwd, 'private.key'), {encoding: 'utf8'})
  const cert = fs.readFileSync(program.cert || path.join(cwd, 'certificate.pem'), {encoding: 'utf8'})
  let dhparam
  if (program.dhparam) {
    dhparam = fs.readFileSync(program.dhparam, {encoding: 'utf8'})
  }
  const port = program.port || 80
  const httpsPort = program.httpsPort || 443
  const result = {key, cert, dhparam, port, httpsPort}
  if (processResult) {
    processResult(program, result)
  }
  return result
}

const commandOptions = {
  addExtraOptions (program) {
    program.option('--domain [dir]', `Base path to the all the domain directories`)
  },
  processResult (program, result) {
    // Mutate the result object as you wish
    result.domainDir = program.domain
  }
}

const {key, cert, dhparam, port, httpsPort, domainDir} = command(process.argv, commandOptions)

const redirectorHandler = (req, res, next) => {
  const bareDomain = (req.hostname.split('.').length === 2)
  debug(req.hostname, 'Bare domain:', bareDomain, 'Protocol:', req.protocol)
  if (bareDomain || req.protocol !== 'https') {
    let hostname = req.hostname
    if (bareDomain) {
      hostname = `www.${hostname}`
    }
    let url = `https://${hostname}`
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

async function domainApp (domain) {
  const webrootStaticDir = path.join(domainDir, domain, 'webroot')
  const redirectsFile = path.join(domainDir, domain, 'redirects.json')

  let redirects = {}
  try {
    if (fs.existsSync(redirectsFile)) {
      redirects = JSON.parse(fs.readFileSync(redirectsFile))
    }
  } catch (e) {
    debug('Error:', e)
  }

  const proxyFile = path.join(domainDir, domain, 'proxy.json')
  let proxyPaths = []
  try {
    if (fs.existsSync(proxyFile)) {
      proxyPaths = JSON.parse(fs.readFileSync(proxyFile))
    }
  } catch (e) {
    debug('Error:', e)
  }

  const usersFile = path.join(domainDir, domain, 'users.json')
  let users = {}
  try {
    if (fs.existsSync(usersFile)) {
      users = JSON.parse(fs.readFileSync(usersFile))
    }
  } catch (e) {
    debug('Error:', e)
  }

  const app = express()

  app.disable('x-powered-by')
  app.use('/.webroot', express.static(path.join(webrootStaticDir, '.webroot')))
  // This is to redirect to https://www.
  app.use(redirectorHandler)
  debug('Set up redirectorHandler')

  // If nothing has been matched, check the redirects and redirect the URL, keeping the query string.
  app.get('*', async (req, res, next) => {
    const target = redirects[req._parsedUrl.pathname]
    if (!target) {
      return next()
    }
    res.setHeader('Location', req.url.replace(req._parsedUrl.pathname, target))
    res.status(302).send('Redirecting ...')
  })

  if (Object.keys(users).length) {
    const o = {users, challenge: true}
    debug('Using basic auth with these settings:', o)
    app.use(basicAuth(o))
  }

  // We'll have this last because it will redirect /something to /something/ if it can't be found.
  // this can mess with the behaviour above
  for (let i = 0; i < proxyPaths.length; i++) {
    debug(proxyPaths[i][0], proxyPaths[i][1])
    app.use(proxyPaths[i][0], proxy(proxyPaths[i][1], {
      limit: '900mb',
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
        debug('!!!!!!!!!!!!', req.originalUrl)
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
  }
  return app
}

async function main () {
  const dirs = fs.readdirSync(domainDir)
  const secureContext = {}
  const app = express()
  for (let d = 0; d < dirs.length; d++) {
    const domain = dirs[d]
    const stat = fs.statSync(path.join(domainDir, domain))
    if (stat && stat.isDirectory()) {
      const sniDir = path.join(domainDir, domain, 'sni')
      debug('Adding domain', domain)
      secureContext[domain] = tls.createSecureContext({
        key: fs.readFileSync(path.join(sniDir, 'key.pem'), 'utf8'),
        cert: fs.readFileSync(path.join(sniDir, 'cert.pem'), 'utf8')
        // ca: fs.readFileSync('./path_to_certificate_authority_bundle.ca-bundle1', 'utf8'), // this ca property is optional
      })
      const vhostApp = await domainApp(domain)
      app.use(vhost(domain, vhostApp))
      app.use(vhost(domain.slice(4), vhostApp))
      secureContext[domain.slice(4)] = secureContext[domain]
    }
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
    .listen(httpsPort, (error) => {
      if (error) {
        debug('Error:', error)
        return process.exit(1)
      } else {
        debug(`Listening for HTTPS requests on port ${httpsPort}`)
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
    debug(`Could not serve HTTPS on port ${httpsPort}`, e)
  }

  http.createServer(app).listen(port, (error) => {
    if (error) {
      debug('Error:', error)
      return process.exit(1)
    } else {
      debug(`Listening for HTTP requests on port ${port}`)
    }
  })
}

main()

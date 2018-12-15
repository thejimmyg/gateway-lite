const basicAuth = require('express-basic-auth')
const chokidar = require('chokidar')
const dashdash = require('dashdash')
const debug = require('debug')('gateway-lite')
const express = require('express')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const proxy = require('express-http-proxy')
const schedule = require('node-schedule')
const shell = require('shelljs')
const tls = require('tls')
const vhost = require('vhost')

process.on('SIGINT', function () {
  console.log('Exiting ...')
  process.exit()
})

const cwd = process.cwd()

const command = (args) => {
  const options = [
    {
      name: 'domain',
      type: 'string',
      help: 'Base path to the all the domain directories',
      helpArg: 'DIR',
    },
    {
      name: 'key',
      type: 'string',
      help: 'Path to the HTTPS private key',
      helpArg: 'PATH',
    },
    {
      name: 'cert',
      type: 'string',
      help: 'Path to the HTTPS certificate',
      helpArg: 'PATH',
    },
    {
      name: 'port',
      type: 'string',
      help: 'Port for HTTP, defaults to 80',
      helpArg: 'PORT',
    },
    {
      name: 'https-port',
      type: 'string',
      help: 'Port for HTTPS, defaults to 443',
      helpArg: 'PORT',
    },
    {
      name: 'email',
      type: 'string',
      help: `An email that has agreed to the Let's Encrypt terms and is used for the Let's Encrypt account`,
      helpArg: 'EMAIL',
    },
    {
      name: 'lets-encrypt',
      type: 'bool',
      help: `Use Let's Encrypt to create missing certificates, and renew older Let's Encrypt certificates before expiry`,
      default: false,
    },
    {
      name: 'staging',
      type: 'bool',
      help: `Use the Let's Encrypt staging server`,
      default: false,
    },
    {
      name: 'proxy',
      type: 'string',
      help: `Proxy sepc`,
      helpArg: 'SPEC',
      default: '{}',
    },
    {
      name: 'redirect',
      type: 'string',
      help: `Redirect sepc`,
      helpArg: 'SPEC',
      default: '{}',
    },
    {
      name: 'user',
      type: 'string',
      help: `User sepc`,
      helpArg: 'SPEC',
      default: '{}',
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
  const proxy = JSON.parse(program.proxy)
  const user = JSON.parse(program.user)
  const redirect = JSON.parse(program.redirect)
  debug('PROXY', proxy)
  debug('user', user)
  debug('redirect', redirect)
  let httpsOptions
  if (program.httpsPort || program.key || program.cert) {
    const httpsPort = program.httpsPort || 443
    const msg = `Configured for HTTPS on ${httpsPort}.`
    console.log(msg)
    debug(msg)
    httpsOptions = {key: program.key, cert: program.cert, httpsPort, proxy, user, redirect}
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
      debug('No redirection needed')
      next()
    }
  }
}

async function domainApp (domainDir, domain, httpOptions, httpsOptions) {
  let redirects = {}
  let proxyPaths = []
  let users = {}
  try {
    const redirectsFile = path.join(domainDir, domain, 'redirects.json')
    try {
      if (fs.existsSync(redirectsFile)) {
        redirects = JSON.parse(fs.readFileSync(redirectsFile))
      }
    } catch (e) {
      debug('  Error:', e)
    }
    const r = httpsOptions.redirect[domain] || []
    for (let i = 0; i < r.length; i++) {
      redirects.push(r[i])
    }
    debug(domain, redirects)

    const proxyFile = path.join(domainDir, domain, 'proxy.json')
    try {
      if (fs.existsSync(proxyFile)) {
        proxyPaths = JSON.parse(fs.readFileSync(proxyFile))
      }
    } catch (e) {
      debug('  Error:', e)
    }
    const p = httpsOptions.proxy[domain] || []
    for (let i = 0; i < p.length; i++) {
      proxyPaths.push(p[i])
    }
    debug(domain, proxyPaths)

    const usersFile = path.join(domainDir, domain, 'users.json')
    try {
      if (fs.existsSync(usersFile)) {
        users = JSON.parse(fs.readFileSync(usersFile))
      }
    } catch (e) {
      debug('  Error:', e)
    }
    const u = httpsOptions.user[domain] || []
    for (let i = 0; i < u.length; i++) {
      users.push(u[i])
    }
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
      const {auth = false, limit = '500mb', ...rest} = options || {}
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
        //   debug(proxyResData)
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
          const ip = req.ip.split(':')[3]
          debug(ip, req.protocol)
          proxyReqOpts.headers['X-Real-IP'] = ip
          proxyReqOpts.headers['X-Forwarded-For'] = ip
          proxyReqOpts.headers['X-Forwarded-Proto'] = req.protocol
          return proxyReqOpts
        },
        timeout: 2 * 60 * 1000
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
      debug('SKipping domain', domain)
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
              let cmd = `certbot certonly --webroot -w "domain/${domain}/webroot" -d "${domain}" -n -m "${email}" --agree-tos`
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
                  shell.cp(`/etc/letsencrypt/live/${domain}/fullchain.pem`, path.join(domainDir, domain, 'sni', 'cert.pem'))
                  if (shell.error()) {
                    let msg = `Could not copy '/etc/letsencrypt/live/${domain}/fullchain.pem'`
                    debug(msg)
                    reject(new Error(msg))
                  } else {
                    shell.cp(`/etc/letsencrypt/live/${domain}/privkey.pem`, path.join(domainDir, domain, 'sni', 'key.pem'))
                    if (shell.error()) {
                      let msg = `Could not copy '/etc/letsencrypt/live/${domain}/provkey.pem'`
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
    }
    debug('Setting up virtual hosts ...')
    const vhostApp = await domainApp(domainDir, domain, httpOptions, httpsOptions)
    app.use(vhost(domain, vhostApp))
  }

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

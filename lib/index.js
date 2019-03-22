const shell = require('shelljs')
const debug = require('debug')('gateway-lite')
const path = require('path')

const installCertificates = async (domainDir) => {
  const domains = shell.ls(domainDir)
  if (shell.error()) {
    debug(`Could not list ${domainDir}`)
    debug('Failed to install the new renewed certificates')
  } else {
    let successes = 0
    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i]
      try {
        await copyCerts(domainDir, domain)
        successes = successes + 1
      } catch (e) {
        debug(`Did not find a Lets Encrypt certificate for ${domain}`)
      }
    }
    return successes
  }
}

const copyCerts = async (domainDir, domain) => {
  let fixed = false
  shell.cp(`/etc/letsencrypt/live/${domain}/fullchain.pem`, path.join(domainDir, domain, 'sni', 'cert.pem'))
  if (shell.error()) {
    throw new Error(`Could not copy /etc/letsencrypt/live/${domain}/fullchain.pem`)
  } else {
    shell.cp(`/etc/letsencrypt/live/${domain}/privkey.pem`, path.join(domainDir, domain, 'sni', 'key.pem'))
    if (shell.error()) {
      throw new Error(`Could not copy /etc/letsencrypt/live/${domain}/privkey.pem`)
    } else {
      fixed = true
    }
  }
  return fixed
}

module.exports = {copyCerts, installCertificates}

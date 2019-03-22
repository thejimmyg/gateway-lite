#!/usr/bin/env node

const debug = require('debug')('gateway-lite')
const {installCertificates} = require('../lib/')

const main = async () => {
  if (process.argv.length < 3) {
    console.log('usage: install-certificates DOMAIN_DIR')
    process.exit(1)
  }
  try {
    const successes = await installCertificates(process.argv[2])
    if (successes > 0) {
      const msg = `Installed ${successes} certificates`
      console.log(msg)
      debug(msg)
      process.exit(0)
    } else {
      console.log(`Failed to install any certificates`)
      process.exit(2)
    }
  } catch (e) {
    console.error(`Error occured: ${e}`)
    process.exit(3)
  }
}

main()

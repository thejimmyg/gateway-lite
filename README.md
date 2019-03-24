# Gateway Lite

An HTTP/HTTPS frontend express server for proxying to plain HTTP backends.
Supports multiple domains, redirect, proxy paths, basic auth and automatic Lets
Encrypt certificates.

Currently only designed for URLs structures like this:

* www.example.com
* www.example.localhost

Designed to to be able to replace Nginx in your deployment.
Express is much easier to work with in many circumstances than Nginx so it
might well be easier to get the configuration you need using this project as a
starting point.

**CAUTION: Under active development, not ready for production use by people
outside the development team yet.**


The basic idea is that you create a directory structure of domains
in this structure with one directory for each domain you want to support:

```
domain/
├─── www.example.localhost
│   ├── proxy.json
│   ├── redirects.json
│   ├── sni
│   │   ├── cert.pem
│   │   └── key.pem
│   ├── users.json
│   ├── pwa.json
│   └── webroot
│       └── .well-known
│           └── acme-challenge
└── some.example.com
    └─── ... same as above
```

The different files and directories for each domain configure different aspects
of the gateway.

The project is available as a docker container here: [https://hub.docker.com/r/thejimmyg/gateway-lite/](https://hub.docker.com/r/thejimmyg/gateway-lite/)

If you have two variants of the same domain, never symlink the directories because the certificates placed in each are for the specific domains. You must create a directory structure for each.

Next is a description of all the configuration options. Each of these is run in
the order they are described here, so SSL checking happens before redirects
which happen before auth which happens before proxying.

*`webroot`*

This is a directory which contains a `.well-known/acme-challenge` directory that `certbot` can
use to automatically renew SSL certificates. See `Certbot` section later.

*Automatic Redirects* (no file, always enabled)

Any bare domains (e.g. example.com but not subdomain.example.com) get
redirected to the HTTPS equivalent at the `www` subdomain. So for example, all
these URLs get redirected to `https://www.example.com`:

* http://example.com
* https://example.com
* http://www.example.com

*`redirect.json`*

A JSON file (must be valid JSON, not just JavaScript) that contains the set of
redirects you would like perfomed. For example:

```
{
  "/some-path": "/"
}
```

*`users.json`*

A JSON file structured like this:

```
{"admin": "supersecret"}
```

Usernames are case insensitive, so it makes sense to specify them all as lowercase. Be careful not to add two keys with different cases as it is not guaranteed which associated password would be used.

**CAUTION: Not terribly secure, plain passwords. But OK for now.**

This defines all the users who can sign into the system.

*`pwa.json`*

If this file is present, we treat this domain as hosting a *progressive web app*. Specifically, Gateway Lite will:

* Generate a service worker at `serviceWorkerUrl` (by default `/sw.js`) such that the start URL, network error URL and all the other URLs you need are cached for offline use when there is a network error
* Generate an application manifest at `manifestUrl` (by default `manifest.json`)

Together these will enable your website to be added to the home screen on Android and iOS as well as made into a Chrome app by Chrome or on Chromebooks.

You'll also need to make sure all your pages have this script in them to load the service worker (where `/sw.js` matches the `serviceWorkerUrl` value:

```
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
  .then(function(reg) {
    // registration worked
    console.log('Registration succeeded. Scope is ' + reg.scope);
  }).catch(function(error) {
    // registration failed
    console.log('Registration failed with ' + error);
  });
}
```

and that the head contains markup similar to the following but reflecting the real paths you are using:

```
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/public/theme/manifest.json">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#000000" />
<link rel="apple-touch-icon" href="/public/theme/icon192.png">
<link rel="icon" sizes="192x192" href="/public/theme/icon192.png">
<link rel="shortcut icon" type="image/png" href="/public/theme/icon.png">
```

Here is a sample `pwa.json` you can customise:

```
{
    "name": "My App",
    "shortName": "myapp",
    "display": "standalone",
    "startUrl": "/start",
    "networkErrorUrl": "/network-error",
    "serviceWorkerUrl": "/sw.js",
    "manifestUrl": "/manifest.json",
    "urlsToCache": [
       ["/edit/public/theme/bootstrap.min.js", "/upload/public/theme/bootstrap.min.js"],
       ["/edit/public/theme/icon.png"],
    ],
    "backgroundColor": "#fffff",
    "themeColor": "#000000",
    "version": "0.1.0",
    "defaultLocale": "en",
    "description": "An app",
    "icon192Url": "/public/icon192.png",
    "icon192File": "./icon192.png",
    "icon512Url": "/public/icon512.png",
    "icon512File": "./icon512.png"
}
```

The `urlsToCache` option is where you specify all the extra resources your
network error and start pages will need in order to render correctly when there is no
network available. The 192 and 512 icons are served automatically, so you don't
need to specify them again.

Sometimes the same file is served at multiple URLs in your site. For each array
in the array of arrays structure, the generated service worker only fetches a
response for the first of each of the listed files and uses that cached
response to serve the requests for the others. In the example above
`/edit/public/theme/bootstrap.min.js` would be fetched and then cached by the
browser as both `/edit/public/theme/bootstrap.min.js` and
`/upload/public/theme/bootstrap.min.js` with only the one download.

The `version` option is included in the served `/sw.js` file, so that when you
change version number, all browsers will re-download the URLs they need.
**Caution: If you forget to update the version number, some browsers might use
old versions of those files, so update the version number any time any of the
`urlsToCache`, `startUrl` or `networkErrorUrl` change.

The icon files are automatically served from the domain directory (the one
containing the `pwa.json` path).

*`proxy.json`*

```
[
  ["/v2", "registry:5000/v2"],
  ["/", "hello:8000/world"]
]
```

Redirects `/v2/` to `http://registry:8000/v2/`. In this example `hello`
and `registry` are an internal DNS name set up by `docker-compose` (see the
Docker section below) but you can also have normal hosts like
`my.internal.domain.example.com`.

The downstream destinations are checked against the request path from top to
bottom, so if you had put the `hello` before `registry`, then registry would
never be accessible - all paths start with `/`, so `/v2/` would never be
checked.

Because a path is specifed for `"hello:8000/world"`, requests to `/` will go to
`hello:8000/world/`.

The third argument is optional, but if specified can have these keys:

* `auth` - can be `false` (default) to mean no security is added or `true` to
  mean the user has to sign in with a credential in `users.json` to be able to
  access the route
* `authExceptOptions` - can be `false` (default) to mean no security is added
  or `true` to mean the user has to sign in with a credential in `users.json` to
  be able to access the route, except if it is an OPTIONS request which will get
  passed through anyway. This is handy for enabling CORS pre-flight requests.
* `cascade` - can be set to `true` to enable cascade behaviour. In this mode
  if a downstream server returns a 404, Gateway Lite will simply try the next
  downstream server
* `limit` - the maximum size of an incoming request specified in
  [bytes.js](https://www.npmjs.com/package/bytes) format. Default is `500mb`.
* `ws` - Whether to support websocket proxying too. Default is `false`. If
   set to `true` you can't use the `limit` or `cascade` options

Internally, the path you specify as the first argument is passed to `app.use()` not `app.all()` so that any sub-path is also proxied.

**CAUTION: Proxying is *always* done over HTTP though, so make sure the hosts
being proxied to are on a trusted network or the same computer otherwise
security credentials etc will be sent unencrypted by the proxy to the
destination server.**

**NOTE: If you secure a route and sign in with Basic auth using the credentials
in your `users.json` file, the browser saves your credentials until you *exit
the browser* or clear your cache. Closing the tab is not enough.**


## Set up a testing certificate

For local testing, let's imagine you want to use the domain `www.example.localhost`.

You can create certificates as described here:

* https://letsencrypt.org/docs/certificates-for-localhost/

You'll need to put them in the directory `domain/www.example.localhost/sni` in this example. Here's some code that does this:

```
mkdir -p domain/www.example.localhost/sni
openssl req -x509 -out domain/www.example.localhost/sni/cert.pem -keyout domain/www.example.localhost/sni/key.pem \
  -newkey rsa:2048 -nodes -sha256 \
  -subj '/CN=www.example.localhost' -extensions EXT -config <( \
   printf "[dn]\nCN=www.example.localhost\n[req]\ndistinguished_name = dn\n[EXT]\nsubjectAltName=DNS:www.example.localhost\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth")
```

Now edit your `/etc/hosts` so that your domain really points to `127.0.0.1` for local testing. You should have a line that looks like this:

```
127.0.0.1	localhost www.example.localhost example.localhost
```

On macOS, to make the browsers trust this certificate follow these steps:

* Visit the URL in chrome https://www.example.localhost:3000/
* Click on `Not Secure` in the URL bar, and then on `Certificate (invalid)`
* Drag the big certificate icon to your Desktop
* Load `Keychain Access` (from your Applications->Utilitites folder or from Spotlight)
* Click on `System` in the `Keychains` panel in the top right
* Drag the certificate from your Desktop into the list of System certificates
* Enter your password to approve the drag
* Double click the certificate from the the location you dragged it to in the list
* Expand the `Trust` section
* Change `When using this certificate` from `Use System Defaults` to `Always Trust`. This changes the other dropdowns too.
* Close the popup and enter your password again to confirm
* Close `Keychain Access`
* Visit the URL again in the browser

The certificate should now be trusted in other browsers like Safari too (but won't be trusted by `curl`, you should use the `-k` option to curl to ignore invalid certificates).

## Install and Run

```
npm install
DEBUG=gateway-lite npm start -- --https-port 3000 --port 8001 --cert domain/www.example.localhost/sni/cert.pem --key domain/www.example.localhost/sni/key.pem --domain domain --lets-encrypt --email james@example.com --user='{"www.example.localhost": {"hello": "eyJoYXNoIjoiU2xkK2RwOGx3cFM1WDJzTHlnTUxmOXhNTlZ5NHV5UjZwK3pQTGhNLzJqMVRlRTF5Q1AxbURzQkpvSTFKRlBSd3V1akIrcng0aDhxNlJBNXRuRVlWUVNpWiIsInNhbHQiOiIwU3NIZnJDMEY1OUZZQmhHSnRKb2QvN3NMTzh3Um82Wm5mTnl6VThIeHYyV2FrdWd6dDhZc09nSDJwUHBiMnAxQlczU1BTWDN5L29GczlaN1NqTktpc2h3Iiwia2V5TGVuZ3RoIjo2NiwiaGFzaE1ldGhvZCI6InBia2RmMiIsIml0ZXJhdGlvbnMiOjcyNjIzfQ=="}}' --proxy='{"www.example.localhost": [["/auth", "localhost:8000/auth", {"auth": true}]]}' --redirect='{"www.example.localhost": {"/some-path": "/"}}' --pwa='{"www.example.localhost": {"networkErrorUrl":"/auth/network-error", "icon192Url":"/public/theme/icon192.png", "startUrl":"/auth/start"}}'
```

You can get further debugging with `DEBUG=gateway-lite,express-http-proxy`.

You can put an icon at `domain/www.example.com/icon192.png` if you want one displayed at `/public/theme/icon192.png`.

The certificates you specify here are used if a SNI match can't be found to use
a better certificate for the domain.

The example above also enables service workers.

**Caution: When using service workers the browser caches resources so it can be confusing to debug things. To force the browser to refresh, try setting a new version number, or clear the browser service worker cache.**

To test everything is working, run a server on port 8000. There is a suitable project called `express-downstream` but you could run any server.

Now visit https://www.example.localhost:3000/some-path and after being redirected to `/` and
you should see the message proxied from the downstream server.

If you visit https://www.example.localhost:3000/auth you should be prompted to sign in. The username `hello` and password `world` should be accpeted:

```
curl -k -v -u hello:world https://www.example.localhost:3000/auth
# A different case username works too:
curl -k -v -u HeLlo:world https://www.example.localhost:3000/auth
```

If you don't have a separate downstream server running or you visit `/` instead of `/auth` you'll see `{"error":"504"}` instead. With the wrong password you'd see `HTTP/1.1 401 Unauthorized` in the response headers.

You can use plain text passwords instead of the password hashes if you prefer, as long as they are less than or equal to 64 characters long. You can generate your own hashes by running this server, signing in with `hello` and `world` and visiting the hash generator at http://localhost:8000/hash

```
npm install express-mustache-jwt-signin
cd node_modules/express-mustache-jwt-signin
USERS_YML=yaml/users.yml MUSTACHE_DIRS="views-overlay" PUBLIC_FILES_DIRS="public-overlay" SCRIPT_NAME="" HTTPS_ONLY=false PORT=8000 SECRET='reallysecret' DEBUG=express-mustache-jwt-signin,express-mustache-jwt-signin:credentials,express-mustache-jwt-signin:hash,express-mustache-overlays npm start
```

Then return to the directory for gateway-lite with:

```
cd ../../
```

When visiting `/auth` with the `express-mustache-overlays` downstream server
through the PWA-enabled proxy, you should see that the scripts are only fetched
once, and that as you navigate from page to page, PJAX is used (look in the
console to check there aren't full page refreshes). You should also find the
network error page is dipslayed if you stop one of the servers, and an service
worker and app manifest are set up for you.

## Docker Compose and Certbot

One of the possibilities this project enables is to run multiple services on
the same physical machine. A good architecture for doing this is to have
`gateway-lite` proxy to a Docker registry container for pushing docker
containers too, and then using docker-compose to also run those pushed
containers as the various services.

Something to watch out for if you use Docker is that you don't have any
containers sharing the same internal port. (So don't have two that internally
use 8000 for example).

There are some instructions for provisioning an Ubuntu 18.04 ami on AWS with Docker Compose in [AWS.md](https://github.com/thejimmyg/gateway-lite/blob/master/AWS.md).

At this point you should be able to run a gateway.

Get a terminal running on the machine on which you want to run the gateway for carrying out these next steps.

Write this to a `docker-compose.yml` file on the machine, replacing `james@example.com` with an email address that has accepted the Let's Encrypt terms (who will receive any messages from Let's Encrypt) and `www.example.localhost` with your real domain name.

```
version: "3"
services:
  gateway:
    restart: unless-stopped
    image: thejimmyg/gateway-lite:0.2.17
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./domain:/app/domain
      - ./letsencrypt:/etc/letsencrypt
    environment:
      DEBUG: gateway-lite,express-http-proxy
    command: ["--https-port", "443", "--port", "80", "--cert", "domain/www.example.localhost/sni/cert.pem", "--key", "domain/www.example.localhost/sni/key.pem", "--domain", "domain", "--lets-encrypt", "--email", "james@example.com"]
```

It is OK to run Docker Compose from your user's home directory for example.

Create a directory for Let's Encrypt that will be mounted into your Docker container. This allows you to keep your certificates between restarts (essential):

```
mkdir -p letsencrypt
```

Setup a basic domain structure for your domain:

```
export DOMAIN=example.com
mkdir -p domain/$DOMAIN
cd domain
mkdir -p $DOMAIN/webroot/.well-known
cat << EOF > $DOMAIN/webroot/.well-known/hello
world!
EOF
mkdir -p $DOMAIN/sni
cd ../
cp -pr $DOMAIN www.$DOMAIN
```

If you already have certificates, put them in these locations, otherwise Let's Encrypt will create them for you and put them in the right place:

* domain/${DOMAIN}/sni/cert.pem
* domain/${DOMAIN}/sni/key.pem
* domain/www.${DOMAIN}/sni/cert.pem
* domain/www.${DOMAIN}/sni/key.pem

You are now ready to go!

Before Let's Encrypt can get certificates, your domain must be publicly accessible on the internet, and connected to the server IP you are about to run.

With your DNS A records in place, run Docker Compose:

```
docker-compose up
```

You can add the `-d` flag to have Docker run everything as a daemon and keep it
running, as well as to start up automatically when you reboot.

You'll see this initially as part of the output from the first boot:

```
gateway_1  | 2018-12-07T15:44:24.857Z gateway-lite Error: ENOENT: no such file or directory, open 'domain/www.example.localhost/sni/key.pem'
gateway_1  |     at Object.openSync (fs.js:436:3)
gateway_1  |     ...
```

At this point, Gateway Lite should get you a certificate, notice the change and restart, so that everything now works.

```
curl http://$DOMAIN/.well-known/hello
curl http://www.$DOMAIN/.well-known/hello
```

In both cases you should see `world!`.

You can now restart the server in daemon mode. Press `Ctrl+C` and wait a few seconds to safely stop the server, then run:

```
docker-compose up -d
```

Bear in mind that Let's Encrypt operates a rate limit as described here:

[https://letsencrypt.org/docs/rate-limits/](https://letsencrypt.org/docs/rate-limits/)

This means that you should be careful that everything is correctly configured
before applying for a certificate. There is also a staging environment you can
use when setting things up. Pass `--staging` when running Gateway Lite to use
the Let's Encrypt staging environment.

Your gateway should restart when new certificates are added and it should
automatically renew certificates as long as it is left up and running.

If you want to manually restart everything, in the same directory as your
`docker-compose.yml` file, run this:

```
docker-compose down
docker-compose up -d
```

You can view your logs:

```
docker-compose logs --tail="10" -f
```

Now you should be able to visit the root of your domain and be correctly
redirected to HTTPS which will give you an error that no `proxy.json` file is
yet set up for downstream servers.

From a terminal where you have set up `DOMAIN` to point to your domain:

```
curl -v http://$DOMAIN 2>&1 | grep "Redirecting"
curl -v https://$DOMAIN 2>&1 | grep "Redirecting"
```

Let's add a Docker Registry container for pushing private docker images to, and
a simple hello world server both downstream from the gateway. We'll call them
`registry` and `hello`.

First, edit the `docker-compose.yml` file to add a `links` config to the end of
the `gateway` section to points to the two other containers by name:

```
    links:
      - hello:hello
      - registry:registry
```

Internally Docker will use this to set up a network so that from within the
gateway, the `hello` will point to the IP of the running `hello` container and
`registry` will point to the name of the running `registry` container.

This means that with this configuration if you were able to run `curl
http://registry:5000/v2/` from the `gateway` container you'd see the response
from the HTTP service running on port 5000 in the `registry` container.

Next add the sections for the two new services:

```
  hello:
    restart: unless-stopped
    image: thejimmyg/downstream:latest
    ports:
      - "8000:8000"
  registry:
    image: registry:2.6.2
    restart: unless-stopped
    ports:
      - 5000:5000
    environment:
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /data
    volumes:
      - ./data:/data
```

Your `docker-compose.yml` should now look like this:

```
version: "3"
services:
  gateway:
    restart: unless-stopped
    image: thejimmyg/gateway-lite:latest
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./domain:/app/domain
      - ./letsencrypt:/etc/letsencrypt
    environment:
      DEBUG: gateway-lite,express-http-proxy
    command: ["--https-port", "443", "--port", "80", "--cert", "domain/www.example.localhost/sni/cert.pem", "--key", "domain/www.example.localhost/sni/key.pem", "--domain", "domain", "--lets-encrypt", "--email", "james@example.com"]
    links:
      - hello:hello
      - registry:registry
  hello:
    restart: unless-stopped
    image: thejimmyg/downstream:latest
    ports:
      - "8000:8000"
  registry:
    image: registry:2.6.2
    restart: unless-stopped
    ports:
      - 5000:5000
    environment:
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /data
    volumes:
      - ./data:/data
```

Make a data directory for Docker registry:

```
mkdir data
```

Now you'll need to tell the gateway-lite server how to proxy to the downstream
service. You do this with the `domain/$DOMAIN/proxy.json` file:

```
[
  ["/v2/", "registry:5000", {"auth": true}],
  ["/", "hello:8000", {"path": "/"}]
]
```

See the earlier documentation to understand the format.

To make your server private so that people can't push to Docker Registry you
can sign in with the credentials in `domain/$DOMAIN/users.json`:

```
{"admin": "secret"}
```

**CAUTION: Use your own username and password, `admin` and `secret` are too
easy to guess.**

Restart docker compose again:

```
docker-compose down
docker-compose up -d
```

If you visit `/` you should see the `Hello!` page from `thejimmyg/downstream:latest`:

```
curl https://www.$DOMAIN
```

Gives:

```
Hello!

/
```


Now, to use the Docker Registry you'll need to sign in with the credentials you set up. Visit `/v2/` and you should see `{}`.

```
curl -v -u admin:secret https://$DOMAIN/v2/
```

You'll need to close your browser or clear your cache to sign out since this only uses Basic Auth.

From another machine you should be able to sign in to your registry:

```
docker login $DOMAIN
```

Once signed in, you should be able to push and pull images. For example:

```
docker build . -t docker.jimmyg.org/gateway-lite:latest
docker push docker.jimmyg.org/gateway-lite:latest
```

When you are deploying docker images that you pushed to your own private repo,
you'll need to explicitly pull them with `docker pull` before restarting the
server with Docker Compose because can't pull from the registry automatically
if the registry itself isn't running.


## Development

```
export DOMAIN=www.example.localhost
mkdir -p domain/$DOMAIN/sni/
openssl req -x509 -out domain/$DOMAIN/sni/cert.pem -keyout domain/$DOMAIN/sni/key.pem \
  -newkey rsa:2048 -nodes -sha256 \
  -subj "/CN=$DOMAIN" -extensions EXT -config <( \
   printf "[dn]\nCN=$DOMAIN\n[req]\ndistinguished_name = dn\n[EXT]\nsubjectAltName=DNS:$DOMAIN\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth")
```

Repeat this for:

```
export DOMAIN=example.localhost
```

Then add `example.localhost` and `www.example.localhost` to `/etc/hosts` under 127.0.0.1.

Now you need to trust the certificate which you can do on most operating
systems by double cliking the `cert.pem` file. On macOS you can add it to your login keychain. Just to be safe, best not to
distribute it though once your browser has trusted it as others could use it.

`curl` doesn't use system certifcates on macOS, but use `-k` to ignore security problems when testing locally.

See:

* https://tosbourn.com/getting-os-x-to-trust-self-signed-ssl-certificates/

## Tip

You can also specify the redirects, users and proxy settings for each domain on
the command line in YAML or JSON in your `docker-compose.yml` file. For
example, you could add this to the existing `command:` section:

```
      --redirect '
        www.example.localhost:
          "/some": "/other"
      '
      --proxy '
        www.example.localhost:
          - ["/user", "signin/user", {}]
          - ["/", "markdown"]
      '
      --user '
        www.example.localhost:
          admin: "supersecret"
      '
```


## Changelog

### 0.2.17 2019-03-24

* Added an `authExceptOptions` setting as well as `auth` as a possible option
  in the proxy configuration. They are the same except `authExceptOptions`
  doesn't require authorization for `OPTIONS` requests and will just proxy them
  directly. This is handy if there is a CORS backend that needs to respond to
  an `OPTIONS` pre-flight request before authorization credentials can be
  passed.

### 0.2.16 2019-03-22

* Automatically copy renewed certificates into the domain `sni` directory
* Automatically exit after certificate renewal so that new certificates can be loaded
* Upgraded js-yaml for to fix security audit
* Removed nodemailer as it isn't used
* Created new `install-certificates` script which takes the domain directory as its
  argument and installs the latest certificates from the existing Lets Encrypt directory
  from `/etc/letsencrypt` into the domain directory. Use like this:

  ```
  DEBUG=gateway-lite node bin/install-certificates.js domain
  ```
* Exit after renewing certificates (assumes that the process will be automatically
  restarted to load the new certificates.

### 0.2.15 2019-02-15

* Refactored PWA functionality into pjax-pwa-overlay

### 0.2.13 2019-01-18

* Upgraded for `express-mustache-overlays` 0.4.0

### 0.2.12 2019-01-12

* Use the same PWA environment variables as `express-mustache-overlays` as defaults

### 0.2.11 2019-01-12

* Progressive web app support

### 0.2.10 2019-01-10

* Added `express-http-proxy` back in to support both cascade behaviour or web socket proxying, but not both for the same path at the same time

### 0.2.9 2019-01-10

* Added the `gateway-lite` bin script, and added `#!/usr/bin/env node` to the top of `bin/gateway-lite.js`
* Removed the `limit` and `cascade` options
* Support websocket proxying
* Switched `express-http-proxy` for `http-proxy-middleware`
* Fixed a bug with unknown usernames

### 0.2.8 2019-01-03

* Updated the README with `--proxy` and `--user` example
* Added 405 and 504 HTTP JSON responses to handle ECONNRESET and ECONNREFUSED errors respectively
* Updated `AWS.md` with information about setting up swap space and pruning Docker
* Refactored auth handling so that user names are case insensitive, and passwords longer than 64 characters are treated as hashes as generated and used by `express-mustache-jwt-signin`

### 0.2.7 2019-01-02

* Support the `cascade` argument to the proxy args which, when set to `true` will act if the path was not present if it returns a 404, and will instead try subsequent routes
* Simple 404 and 500 error logging
* Respond to `SIGTERM` as well as `SIGNINT`
* Upgrade `docker-compose.yml` to use `thejimmyg/express-downstream:0.1.4`
* Added YAML command line config example to the docs
* Removed `bin/downstream.js` now that there is [express-downstream](https://github.com/thejimmyg/express-downstream)

### 0.2.6 2018-12-30

* Correctly process YAML specified for the `--user` flag

### 0.2.5 2018-12-19

* Support YAML for all the files, not just JSON
* Changed the default `EXPOSE` ports in Docker to 80 and 443
* Removed `DEFAULT_DOMAIN` from Dockerfile

### 0.2.4 2018-12-16

* Removed `nodemon`
* Made lets encrypt code more reliable by making directories

### 0.2.3 2018-12-15

* Proxy paths are now part of the downstream argument, not an option
* Added `--redirect`, `--proxy`, `--user` arguments (which apply after the file corresponding files are loaded
* Using `dashdash` instead of `commander`
* Removed support for dhparams
* Now need `--lets-encrypt` option to enable the Let's Encrypt support
* Moved downstream out to the `express-downstream` package

### 0.2.2 2018-12-11

* Allow fetched HTTPS certifcates to be used without restarting

### 0.2.1 2018-12-10

* Certbot certificate renews built in
* Don't crash on invalid hostname

### 0.2.0 2018-12-07

* Per-downstream server auth, limit and path options
* Full Docker and Certbot tutorial

### 0.1.0 2018-12-04

First version

## Release

Instructions started in [`RELEASE.md`](RELEASE.md).

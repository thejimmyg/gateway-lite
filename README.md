# Gateway Lite

Front-end HTTP and HTTPS proxy that can Nginx in your deployment. Express is
much easier to work with in many circumstances than Nginx so it might well be
easier to get the configuration you need using this project as a starting
point.

**CAUTION: Under active development, not ready for production use by people
outside the development team yet.**


The basic idea is that you create a directory structure of domains
in this structure with one directory for each domain you want to support:

```
domain/
├─── localhost
│   ├── proxy.json
│   ├── redirects.json
│   ├── sni
│   │   ├── cert.pem
│   │   └── key.pem
│   ├── users.json
│   └── webroot
│       └── .well-known
│           └── acme-challenge
└── some.example.com
    └─── ... same as above
```

The different files and directories for each domain configure different aspects
of the gateway.

The project is available as a docker container here: [https://hub.docker.com/r/thejimmyg/gateway-lite/](https://hub.docker.com/r/thejimmyg/gateway-lite/)

If you have two variants of the same domain, you can always symlink the directories:

```
ln -s some.example.com example.com
```

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

**CAUTION: Not terribly secure, plain passwords. But OK for now.**

This defines all the users who can sign into the system.

*`proxy.json`*

```
[
  ["/v2/", "registry:5000"],
  ["/", "hello:8000"]
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

The third argument is optional, but if specified can have these keys:

* `auth` - can be `false` (default) to mean no security is added or `true` to
  mean the user has to sign in with a credential in `users.json` to be able to
  access the route
* `path` - specifies the target path for the downstream server, the default is
  to use the same path that the request was made with
* `limit` - the maximum size of an incoming request specified in
  [bytes.js](https://www.npmjs.com/package/bytes) format

**CAUTION: Proxying is *always* done over HTTP though, so make sure the hosts
being proxied to are on a trusted network or the same computer otherwise
security credentials etc will be sent unencrypted by the proxy to the
destination server.**

Note that the path gets mapped too, no way to map to a different path yet, so
you can't have `/v2/` map to `/` yet).

**NOTE: If you secure a route and sign in with Basic auth using the credentials
in your `users.json` file, the browser saves your credentials until you *exit
the browser* or clear your cache. Closing the tab is not enough.**


## Install and Run

```
npm install
DEBUG=gateway-lite npm start -- --https-port 3000 --port 8001 --cert domain/localhost/sni/cert.pem --key domain/localhost/sni/key.pem --domain domain james@example.com
```

The certificates you sepcify here are used if a SNI match can't be found to use
a better certificate for the domain.

You can get further debugging with `DEBUG=gateway-lite,express-http-proxy`.

If you need a `dhparam.pem` file, you can use the `--dhparam` flag.

To test everything is working, run a server on port 8000, such as the one in
`downstream/bin/downstream.js`:

```
cd downstream
npm start
```

Now visit http://localhost:8001/some-path and after being redirected to `/` and
signing in with `admin` and `supersecret` you should see the `Hello!`
message proxied from the downstream server, along with the path:

```
Hello!

/
```


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

Write this to a `docker-compose.yml` file, replacing `james@example.com` with an email address that has accepted the Let's Encrypt terms:

```
export GATEWAY_LITE_VERSION=0.2.1
cat << EOF > docker-compose.yml
version: "3"
services:
  gateway:
    restart: unless-stopped
    image: thejimmyg/gateway-lite:$GATEWAY_LITE_VERSION
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./domain:/app/domain
    environment:
      DEBUG: gateway-lite,express-http-proxy
    command: ["--https-port", "443", "--port", "80", "--cert", "domain/localhost/sni/cert.pem", "--key", "domain/localhost/sni/key.pem", "--domain", "domain", "james@example.com"]
EOF
```

Create a directory for Let's Encrypt:

```
mkdir -p letsencrypt
```

Setup a basic domain structure for your domain:

TODO: Make the www. redirect configurable and not automatic based on the number of `.` characters in the domain.

```
export DOMAIN=docker.jimmyg.org
mkdir -p domain/$DOMAIN
cd domain
ln -s $DOMAIN www.$DOMAIN
cd $DOMAIN
mkdir -p webroot/.well-known
cat << EOF > webroot/.well-known/hello
world!
EOF
cd ../../
```

To prevent Let's Encrypt from trying to get certificates:

```
touch domain/${DOMAIN}/sni/cert.pem
touch domain/${DOMAIN}/sni/key.pem
touch domain/www.${DOMAIN}/sni/cert.pem
touch domain/www.${DOMAIN}/sni/key.pem
```

To run this with Docker Compose:

```
docker-compose up
```

You can add the `-d` flag to have Docker run everything as a daemon and keep it
running, as well as to start up automatically when you reboot.

You'll see this initially as part of the output from the first boot:

```
gateway_1  | 2018-12-07T15:44:24.857Z gateway-lite Error: ENOENT: no such file or directory, open 'domain/localhost/sni/key.pem'
gateway_1  |     at Object.openSync (fs.js:436:3)
gateway_1  |     ...
```

This is because at the moment there are no secure certificates so gateway-lite
isn't serving any HTTPS requests so if you try to connect with an `https://`
request you'll get a connection error. Since HTTP requests redirect to HTTPS
for most URLs you'll get this problem for most URLs. We'll set up certificates
in a moment.

One directory is serving on HTTP without redirecting though, the `.well-known`
directroy. This directory is used by Let's Encrypt to verify you own the domain
and to issue certificates.

Since you just created a file named `hello` in this directory you should be
able to view it on HTTP at these URLs (replacing `$DOMAIN` with your actual
domain):

```
curl http://$DOMAIN/.well-known/hello
curl http://www.$DOMAIN/.well-known/hello
```

In both cases you should see `world!`.

Now you'll need to get HTTPS certificates.

Whilst you run these next commands you must keep the server running. The easiest way to do that is to restart the server in daemon mode. Press `Ctrl+C` and wait a few seconds to safely stop the server, then run:

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

```
curl -v http://$DOMAIN 2>&1 | grep "Redirecting"
curl https://$DOMAIN
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
    command: ["--https-port", "443", "--port", "80", "--cert", "domain/localhost/sni/cert.pem", "--key", "domain/localhost/sni/key.pem", "--domain", "domain"]
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
cat << EOF > domain/$DOMAIN/proxy.json
[
  ["/v2/", "registry:5000", {"auth": true, "limit": "900mb"}],
  ["/", "hello:8000", {"path": "/"}]
]
EOF
```

See the earlier documentation to understand the format.

To make your server private so that people can't push to Docker Registry you
can sign in with the credentials in `domain/$DOMAIN/users.json`:

```
cat << EOF > domain/$DOMAIN/users.json
{"admin": "secret"}
EOF
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


## Changelog

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

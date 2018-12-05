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

This is a directory which contains a `.webroot` directory that `certbot` can
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

Not terribly secure, plain passwords. But OK for now. If you have a `users.json` file, the browser will always prompt you to enter your username and password. If you enter a correct combination, the browser saves your credentials until you *exit the browser* (not just close the tab) or clear your cache.

*`proxy.json`*

```
[
  ["/v2/", "registry:8000"]
  ["/", "downstream:8000"]
]
```

Redirects `/v2/` to `http://registry:8000/v2/`. In this example `downstream`
and `registry` are an internal DNS name set up by `docker-compose` (see the
Docker section below) but you can also have normal hosts like
`my.internal.domain.example.com`.

CAUTION: Proxying is *always* done over HTTP though, so make sure the hosts
being proxied to are on a trusted network or the same computer otherwise
security credentials etc will be sent unencrypted by the proxy to the
destination server.

Note that the path gets mapped too, no way to map to a different path yet, so
you can't have `/v2/` map to `/` yet).

## Install and Run

```
npm install
DEBUG=gateway-lite npm start -- --https-port 3000 --port 8001 --cert domain/localhost/sni/cert.pem --key domain/localhost/sni/key.pem --domain domain
```

The certificates you sepcify here are used if a SNI match can't be found to use
a better certificate for the domain.

You can get further debugging with `DEBUG=gateway-lite,express-http-proxy`.

If you need a `dhparam.pem` file, you can use the `--dhparam` flag.

To test everything is working, run a server on port 8000, such as the one in `bin/downstream.js`:

```
npm run downstream
```

Now visit http://localhost:8001/some-path and after being redirected to `/` and loging in with `admin` and `supersecret` you should see the `Hello world!` message proxied from the downstream server:

```

Hello World


                                       ##         .
                                 ## ## ##        ==
                              ## ## ## ## ##    ===
                           /""""""""""""""""\___/ ===
                      ~~~ {~~ ~~~~ ~~~ ~~~~ ~~ ~ /  ===- ~~~
                           \______ o          _,/
                            \      \       _,'
                             `'--.._\..--''
```

Something to watch out for is that you don't have any containers sharing the same internal port. (So don't have two that internally use 8000 for example).

Note: You need to close the browser and restart it (or clear your browsing history) to log out after you have signed in.

## Docker

One of the possibilities this project enables is to run multiple services on
the same physical machine. A good architecture for doing this is to have
`gateway-lite` proxy to a Docker registry container for pushing docker
containers too, and then using docker-compose to also run those pushed
containers as the various services.


Here's an example you can use once you have run your own registry. Replace
`docker.example.com` with your own docker registry location.

```
version: "3"
services:
  gateway:
    restart: always
    image: thejimmyg/gateway-lite:0.1.0
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./domain:/app/domain
    environment:
      DEBUG: gateway-lite,express-http-proxy
    command: ["--https-port", "443", "--port", "80", "--cert", "domain/localhost/sni/cert.pem", "--key", "domain/localhost/sni/key.pem", "--domain", "domain"]
    links:
      - downstream:downstream
      - registry:registry
  downstream:
    restart: always
    image: crccheck/hello-world:latest
    ports:
      - "8000:8000"
  registry:
    image: registry:2
    restart: always
    ports:
      - 5000:5000
    environment:
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /data
    volumes:
      - ./data:/data
```

Make a data directory:

```
mkdir data
```

Create a domain setup for your domain:

```
cp -pr domain/localhost domain/docker.example.com
```

To run as part of Docker compose:

```
docker-compose up --build
```

You might get a second or so of downtime after the new containers are built as
the services are swtiched over. You can add the `-d` flag to have Docker run
everything as a daemon and keep it running, as well as to start up
automatically when you reboot.

To add new downstream services, adjust the links in the `gateway` section
`links` so that each downstream service is linked.

In this case we have a Docker registry named `registry` and a simple Hello
world server named `downstream`. The names you use here have to match the names
in your `proxty.json` files when using Docker compose.

```
    links:
      - downstream:downstream
      - registry:registry
```

Within the config for each downstream container you can specify the image like
this if you want it to be pulled from the private docker registry you are
running (assuming your registry is at `registry.example.com`):

```
    image: registry.example.com/hello-world:latest
```

There is a sample `docker-compose.yml` for local development and testing in the
repo, but once you have pushed your containers somewhere you need only a
`docker-compose.yml` file and your `domain` directories in order to deploy a
set of services.

You can login with the credentials in `users.json`:

```
docker login your.example.com
```

## Certbot

The structure is such that you can setup certificates to auto-renew.

```
sudo apt-install certbot
sudo certbot certonly --webroot -w $(pwd)/domain/www.example.com/webroot -d www.example.com -d example.com
```

Renewal is now already set up but you can dry-run it:

```
$ cat /etc/cron.d/certbot
$ sudo certbot renew --dry-run
```

### Troubleshooting

You might see something like this in your docker compose output:

```
gateway_b3b9424a9b9f | [nodemon] 1.18.7
gateway_b3b9424a9b9f | [nodemon] to restart at any time, enter `rs`
gateway_b3b9424a9b9f | [nodemon] watching: /app/domain/**/*
gateway_b3b9424a9b9f | [nodemon] starting `node bin/gateway-lite.js --https-port 3000 --port 8001 --cert domain/localhost/sni/cert.pem --key domain/localhost/sni/key.pem --domain domain`
gateway_b3b9424a9b9f | Error: connect ECONNREFUSED 127.0.0.1:8000
gateway_b3b9424a9b9f |     at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1113:14)
gateway_b3b9424a9b9f | Error: connect ECONNREFUSED 127.0.0.1:8000
gateway_b3b9424a9b9f |     at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1113:14)
```

This is because the `domain/localhost/proxy.json` file specifies `localhost` as the domain but this has no meaning inside the registry. Instead use `downstream` since this is the name you gave in the `docker-compose.yml` file to the downstream container. Within the docker compose network, containers are accessible via their name.


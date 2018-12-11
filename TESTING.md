# Testing

## Testing Locally Only

Assuming that `example.com` is setup for `127.0.0.1` in your `/etc/hosts`, you can run these tests with the demo server:

First test, with no HTTPS available:

```
vim /etc/hosts   # With example.com -> 127.0.0.1 and www.example.com -> 127.0.0.1
mkdir -p domain/www.example.com/webroot/.well-known
cd domain/
ln -s www.example.com example.com
cd ..
DEBUG=gateway-lite npm start
# Serves the data directly
cat << EOF > domain/example.com/webroot/.well-known/test
test
EOF
curl -v http://example.com/.well-known/test 2>&1 | grep test
> GET /.well-known/test HTTP/1.1
test
# Redirects to HTTPS and www, but since HTTPS is not enabled, this will result in the browser not being able to connect after the redirect.
curl -v http://example.com/ 2>&1 | grep Found
< HTTP/1.1 302 Found
# http://www. redirects to https
curl -v http://www.example.com/ 2>&1 | grep Found
< HTTP/1.1 302 Found
Found. Redirecting to https://www.example.com/
# HTTPS is not available yet
curl -v https://www.example.com/ 2>&1  | grep "Connection refused"
* connect to 127.0.0.1 port 443 failed: Connection refused
* Failed to connect to www.example.com port 443: Connection refused
curl: (7) Failed to connect to www.example.com port 443: Connection refused
```

This is enough for you to request an HTTPS certificate from Lets Encrypt (if
you server was set up publicly on the internet and the domain resolves to the
server).

So, now run the `certbot` command to populate `key.pem` and `cert.pem` in
`domain/www.example.com/sni`.

You can now set up a local domain copy for your testing your domain locally,
set `DOMAIN` to match your domain.

```
export DOMAIN=your.example.com
cd domain
mv www.example.com www.$DOMAIN
rm example.com
ln -s www.$DOMAIN $DOMAIN
cd ..
```

Now copy the certificates from `domain/www.${DOMAIN}/sni/` on your server to
your local `domain/www.${DOMAIN}/sni/` direcrtory.

To continue testing, edit `/etc/hosts`, remove the override for `example.com`
and `www.example.com` and set up your real domain to point to `127.0.0.1`
temporarily on your machine. Now the following commands should run fine wihtout
an internet connection.

**NOTE: Remember to take the override out of `/etc/hosts` when you have
finished testing.**

Now run your local server, specifying the valid certificates you've just
created, and using different ports from the default if you like:

```
npm install
DEBUG=gateway-lite npm start -- --https-port 3000 --port 8001 --cert domain/${DOMAIN}/sni/cert.pem --key domain/${DOMAIN}/sni/key.pem --domain domain
```

At this point, everything is using your real certificates, but it thinks that
your domain points to your local computer, so browsers and `curl` will all
work, but point to your local server.

```
# Actually Serve
curl -v https://www.${DOMAIN}
# Redirect to domain above
curl -v http://${DOMAIN}
curl -v http://www.${DOMAIN}
curl -v https://${DOMAIN}
```

You can add a `proxy.json` file to now proxy to a downstream HTTP server
(unsecure connection, so only use on the same machine or a trusted network).


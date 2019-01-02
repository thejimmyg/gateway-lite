# Release

## Version Numbers

```
export OLD_VERSION=0.2.6
git grep $OLD_VERSION | grep -v "package-lock.json" | grep -v "### $OLD_VERSION" | grep -v "express-mustache-overlays" | grep -v "RELEASE.md"
npm install  # To update package.json
```


## Docker

Test by pushing to the `test` tag before deploying the final version.

```
docker login
export DOCKER_ID_USER="thejimmyg"
export VERSION="0.2.6"
docker build . -t "$DOCKER_ID_USER/gateway-lite:$VERSION"
docker push "$DOCKER_ID_USER/gateway-lite:$VERSION"
docker tag "$DOCKER_ID_USER/gateway-lite:$VERSION" "$DOCKER_ID_USER/gateway-lite:latest"
docker push "$DOCKER_ID_USER/gateway-lite:latest"
```

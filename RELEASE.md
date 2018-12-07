# Release

## Example

```
docker login
export DOCKER_ID_USER="thejimmyg"
export VERSION="0.1.0"
docker build . -t "$DOCKER_ID_USER/gateway-lite:$VERSION"
docker push "$DOCKER_ID_USER/gateway-lite:$VERSION"
docker tag "$DOCKER_ID_USER/gateway-lite:$VERSION" "$DOCKER_ID_USER/gateway-lite:latest"
docker push "$DOCKER_ID_USER/gateway-lite:latest"
```



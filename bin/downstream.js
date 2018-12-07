const express = require('express')
const app = express()
const port = 8000

app.get('*', (req, res) => {
  const path = encodeURI(req.path)
  res.send(`<html>
  <head>
    <title>Hello</title>
  </head>
  <body>
    <h1>Hello!</h1>
    <p>${path}</p>
  </body>
</html>`)
})

app.listen(port, () => console.log(`Example app listening on port ${port}!`))

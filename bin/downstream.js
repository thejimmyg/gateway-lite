const express = require('express')
const app = express()
const port = 8000

app.get('*', (req, res) => {
  res.send('<html><head><title>Hello</title></head><body><h1>Hello World!</h1></body></html>')
})

app.listen(port, () => console.log(`Example app listening on port ${port}!`))

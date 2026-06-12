const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`DevOps Playground API listening on port ${PORT}`);
});

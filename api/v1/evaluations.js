const { createHandler } = require('../_lib/evaluation');

module.exports = createHandler({
  kreach: require('../kreach'),
  kosha: require('../kosha'),
});

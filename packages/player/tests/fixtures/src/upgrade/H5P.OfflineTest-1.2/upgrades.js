/**
 * The fixture's upgrade steps, written as a real library's are. Each appends its version to the
 * message, so the text says which ran; `failUpgrade` makes the first throw, for the fallback.
 */
var H5PUpgrades = H5PUpgrades || {};

H5PUpgrades['H5P.OfflineTest'] = (function () {
  return {
    1: {
      1: function (parameters, finished) {
        if (parameters.failUpgrade) {
          throw new Error('The fixture step to 1.1 fails on purpose');
        }
        parameters.message += ' [1.1]';
        finished(null, parameters);
      },
      2: {
        contentUpgrade: function (parameters, finished) {
          parameters.message += ' [1.2]';
          finished(null, parameters);
        }
      }
    }
  };
})();

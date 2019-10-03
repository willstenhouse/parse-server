"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.configureLogger = configureLogger;
exports.addTransport = addTransport;
exports.removeTransport = removeTransport;
exports.default = exports.logger = void 0;

var _winston = _interopRequireWildcard(require("winston"));

var _fs = _interopRequireDefault(require("fs"));

var _path = _interopRequireDefault(require("path"));

var _winstonDailyRotateFile = _interopRequireDefault(require("winston-daily-rotate-file"));

var _lodash = _interopRequireDefault(require("lodash"));

var _defaults = _interopRequireDefault(require("../../defaults"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _getRequireWildcardCache() { if (typeof WeakMap !== "function") return null; var cache = new WeakMap(); _getRequireWildcardCache = function () { return cache; }; return cache; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } var cache = _getRequireWildcardCache(); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; if (obj != null) { var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

const logger = _winston.default.createLogger();

exports.logger = logger;

function configureTransports(options) {
  const transports = [];

  if (options) {
    const silent = options.silent;
    delete options.silent;

    if (!_lodash.default.isNil(options.dirname)) {
      const parseServer = new _winstonDailyRotateFile.default(Object.assign({
        filename: 'parse-server.info',
        json: true,
        format: _winston.format.combine(_winston.format.timestamp(), _winston.format.splat(), _winston.format.json())
      }, options));
      parseServer.name = 'parse-server';
      transports.push(parseServer);
      const parseServerError = new _winstonDailyRotateFile.default(Object.assign({
        filename: 'parse-server.err',
        json: true,
        format: _winston.format.combine(_winston.format.timestamp(), _winston.format.splat(), _winston.format.json())
      }, options, {
        level: 'error'
      }));
      parseServerError.name = 'parse-server-error';
      transports.push(parseServerError);
    }

    const consoleFormat = options.json ? _winston.format.json() : _winston.format.simple();
    const consoleOptions = Object.assign({
      colorize: true,
      name: 'console',
      silent,
      format: consoleFormat
    }, options);
    transports.push(new _winston.default.transports.Console(consoleOptions));
  }

  logger.configure({
    transports
  });
}

function configureLogger({
  logsFolder = _defaults.default.logsFolder,
  jsonLogs = _defaults.default.jsonLogs,
  logLevel = _winston.default.level,
  verbose = _defaults.default.verbose,
  silent = _defaults.default.silent
} = {}) {
  if (verbose) {
    logLevel = 'verbose';
  }

  _winston.default.level = logLevel;
  const options = {};

  if (logsFolder) {
    if (!_path.default.isAbsolute(logsFolder)) {
      logsFolder = _path.default.resolve(process.cwd(), logsFolder);
    }

    try {
      _fs.default.mkdirSync(logsFolder);
    } catch (e) {
      /* */
    }
  }

  options.dirname = logsFolder;
  options.level = logLevel;
  options.silent = silent;

  if (jsonLogs) {
    options.json = true;
    options.stringify = true;
  }

  configureTransports(options);
}

function addTransport(transport) {
  // we will remove the existing transport
  // before replacing it with a new one
  removeTransport(transport.name);
  logger.add(transport);
}

function removeTransport(transport) {
  const matchingTransport = logger.transports.find(t1 => {
    return typeof transport === 'string' ? t1.name === transport : t1 === transport;
  });

  if (matchingTransport) {
    logger.remove(matchingTransport);
  }
}

var _default = logger;
exports.default = _default;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9Mb2dnZXIvV2luc3RvbkxvZ2dlci5qcyJdLCJuYW1lcyI6WyJsb2dnZXIiLCJ3aW5zdG9uIiwiY3JlYXRlTG9nZ2VyIiwiY29uZmlndXJlVHJhbnNwb3J0cyIsIm9wdGlvbnMiLCJ0cmFuc3BvcnRzIiwic2lsZW50IiwiXyIsImlzTmlsIiwiZGlybmFtZSIsInBhcnNlU2VydmVyIiwiRGFpbHlSb3RhdGVGaWxlIiwiT2JqZWN0IiwiYXNzaWduIiwiZmlsZW5hbWUiLCJqc29uIiwiZm9ybWF0IiwiY29tYmluZSIsInRpbWVzdGFtcCIsInNwbGF0IiwibmFtZSIsInB1c2giLCJwYXJzZVNlcnZlckVycm9yIiwibGV2ZWwiLCJjb25zb2xlRm9ybWF0Iiwic2ltcGxlIiwiY29uc29sZU9wdGlvbnMiLCJjb2xvcml6ZSIsIkNvbnNvbGUiLCJjb25maWd1cmUiLCJjb25maWd1cmVMb2dnZXIiLCJsb2dzRm9sZGVyIiwiZGVmYXVsdHMiLCJqc29uTG9ncyIsImxvZ0xldmVsIiwidmVyYm9zZSIsInBhdGgiLCJpc0Fic29sdXRlIiwicmVzb2x2ZSIsInByb2Nlc3MiLCJjd2QiLCJmcyIsIm1rZGlyU3luYyIsImUiLCJzdHJpbmdpZnkiLCJhZGRUcmFuc3BvcnQiLCJ0cmFuc3BvcnQiLCJyZW1vdmVUcmFuc3BvcnQiLCJhZGQiLCJtYXRjaGluZ1RyYW5zcG9ydCIsImZpbmQiLCJ0MSIsInJlbW92ZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7OztBQUFBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOzs7Ozs7OztBQUVBLE1BQU1BLE1BQU0sR0FBR0MsaUJBQVFDLFlBQVIsRUFBZjs7OztBQUVBLFNBQVNDLG1CQUFULENBQTZCQyxPQUE3QixFQUFzQztBQUNwQyxRQUFNQyxVQUFVLEdBQUcsRUFBbkI7O0FBQ0EsTUFBSUQsT0FBSixFQUFhO0FBQ1gsVUFBTUUsTUFBTSxHQUFHRixPQUFPLENBQUNFLE1BQXZCO0FBQ0EsV0FBT0YsT0FBTyxDQUFDRSxNQUFmOztBQUVBLFFBQUksQ0FBQ0MsZ0JBQUVDLEtBQUYsQ0FBUUosT0FBTyxDQUFDSyxPQUFoQixDQUFMLEVBQStCO0FBQzdCLFlBQU1DLFdBQVcsR0FBRyxJQUFJQywrQkFBSixDQUNsQkMsTUFBTSxDQUFDQyxNQUFQLENBQ0U7QUFDRUMsUUFBQUEsUUFBUSxFQUFFLG1CQURaO0FBRUVDLFFBQUFBLElBQUksRUFBRSxJQUZSO0FBR0VDLFFBQUFBLE1BQU0sRUFBRUEsZ0JBQU9DLE9BQVAsQ0FBZUQsZ0JBQU9FLFNBQVAsRUFBZixFQUFtQ0YsZ0JBQU9HLEtBQVAsRUFBbkMsRUFBbURILGdCQUFPRCxJQUFQLEVBQW5EO0FBSFYsT0FERixFQU1FWCxPQU5GLENBRGtCLENBQXBCO0FBVUFNLE1BQUFBLFdBQVcsQ0FBQ1UsSUFBWixHQUFtQixjQUFuQjtBQUNBZixNQUFBQSxVQUFVLENBQUNnQixJQUFYLENBQWdCWCxXQUFoQjtBQUVBLFlBQU1ZLGdCQUFnQixHQUFHLElBQUlYLCtCQUFKLENBQ3ZCQyxNQUFNLENBQUNDLE1BQVAsQ0FDRTtBQUNFQyxRQUFBQSxRQUFRLEVBQUUsa0JBRFo7QUFFRUMsUUFBQUEsSUFBSSxFQUFFLElBRlI7QUFHRUMsUUFBQUEsTUFBTSxFQUFFQSxnQkFBT0MsT0FBUCxDQUNORCxnQkFBT0UsU0FBUCxFQURNLEVBRU5GLGdCQUFPRyxLQUFQLEVBRk0sRUFHTkgsZ0JBQU9ELElBQVAsRUFITTtBQUhWLE9BREYsRUFVRVgsT0FWRixFQVdFO0FBQUVtQixRQUFBQSxLQUFLLEVBQUU7QUFBVCxPQVhGLENBRHVCLENBQXpCO0FBZUFELE1BQUFBLGdCQUFnQixDQUFDRixJQUFqQixHQUF3QixvQkFBeEI7QUFDQWYsTUFBQUEsVUFBVSxDQUFDZ0IsSUFBWCxDQUFnQkMsZ0JBQWhCO0FBQ0Q7O0FBRUQsVUFBTUUsYUFBYSxHQUFHcEIsT0FBTyxDQUFDVyxJQUFSLEdBQWVDLGdCQUFPRCxJQUFQLEVBQWYsR0FBK0JDLGdCQUFPUyxNQUFQLEVBQXJEO0FBQ0EsVUFBTUMsY0FBYyxHQUFHZCxNQUFNLENBQUNDLE1BQVAsQ0FDckI7QUFDRWMsTUFBQUEsUUFBUSxFQUFFLElBRFo7QUFFRVAsTUFBQUEsSUFBSSxFQUFFLFNBRlI7QUFHRWQsTUFBQUEsTUFIRjtBQUlFVSxNQUFBQSxNQUFNLEVBQUVRO0FBSlYsS0FEcUIsRUFPckJwQixPQVBxQixDQUF2QjtBQVVBQyxJQUFBQSxVQUFVLENBQUNnQixJQUFYLENBQWdCLElBQUlwQixpQkFBUUksVUFBUixDQUFtQnVCLE9BQXZCLENBQStCRixjQUEvQixDQUFoQjtBQUNEOztBQUVEMUIsRUFBQUEsTUFBTSxDQUFDNkIsU0FBUCxDQUFpQjtBQUNmeEIsSUFBQUE7QUFEZSxHQUFqQjtBQUdEOztBQUVNLFNBQVN5QixlQUFULENBQXlCO0FBQzlCQyxFQUFBQSxVQUFVLEdBQUdDLGtCQUFTRCxVQURRO0FBRTlCRSxFQUFBQSxRQUFRLEdBQUdELGtCQUFTQyxRQUZVO0FBRzlCQyxFQUFBQSxRQUFRLEdBQUdqQyxpQkFBUXNCLEtBSFc7QUFJOUJZLEVBQUFBLE9BQU8sR0FBR0gsa0JBQVNHLE9BSlc7QUFLOUI3QixFQUFBQSxNQUFNLEdBQUcwQixrQkFBUzFCO0FBTFksSUFNNUIsRUFORyxFQU1DO0FBQ04sTUFBSTZCLE9BQUosRUFBYTtBQUNYRCxJQUFBQSxRQUFRLEdBQUcsU0FBWDtBQUNEOztBQUVEakMsbUJBQVFzQixLQUFSLEdBQWdCVyxRQUFoQjtBQUNBLFFBQU05QixPQUFPLEdBQUcsRUFBaEI7O0FBRUEsTUFBSTJCLFVBQUosRUFBZ0I7QUFDZCxRQUFJLENBQUNLLGNBQUtDLFVBQUwsQ0FBZ0JOLFVBQWhCLENBQUwsRUFBa0M7QUFDaENBLE1BQUFBLFVBQVUsR0FBR0ssY0FBS0UsT0FBTCxDQUFhQyxPQUFPLENBQUNDLEdBQVIsRUFBYixFQUE0QlQsVUFBNUIsQ0FBYjtBQUNEOztBQUNELFFBQUk7QUFDRlUsa0JBQUdDLFNBQUgsQ0FBYVgsVUFBYjtBQUNELEtBRkQsQ0FFRSxPQUFPWSxDQUFQLEVBQVU7QUFDVjtBQUNEO0FBQ0Y7O0FBQ0R2QyxFQUFBQSxPQUFPLENBQUNLLE9BQVIsR0FBa0JzQixVQUFsQjtBQUNBM0IsRUFBQUEsT0FBTyxDQUFDbUIsS0FBUixHQUFnQlcsUUFBaEI7QUFDQTlCLEVBQUFBLE9BQU8sQ0FBQ0UsTUFBUixHQUFpQkEsTUFBakI7O0FBRUEsTUFBSTJCLFFBQUosRUFBYztBQUNaN0IsSUFBQUEsT0FBTyxDQUFDVyxJQUFSLEdBQWUsSUFBZjtBQUNBWCxJQUFBQSxPQUFPLENBQUN3QyxTQUFSLEdBQW9CLElBQXBCO0FBQ0Q7O0FBQ0R6QyxFQUFBQSxtQkFBbUIsQ0FBQ0MsT0FBRCxDQUFuQjtBQUNEOztBQUVNLFNBQVN5QyxZQUFULENBQXNCQyxTQUF0QixFQUFpQztBQUN0QztBQUNBO0FBQ0FDLEVBQUFBLGVBQWUsQ0FBQ0QsU0FBUyxDQUFDMUIsSUFBWCxDQUFmO0FBRUFwQixFQUFBQSxNQUFNLENBQUNnRCxHQUFQLENBQVdGLFNBQVg7QUFDRDs7QUFFTSxTQUFTQyxlQUFULENBQXlCRCxTQUF6QixFQUFvQztBQUN6QyxRQUFNRyxpQkFBaUIsR0FBR2pELE1BQU0sQ0FBQ0ssVUFBUCxDQUFrQjZDLElBQWxCLENBQXVCQyxFQUFFLElBQUk7QUFDckQsV0FBTyxPQUFPTCxTQUFQLEtBQXFCLFFBQXJCLEdBQ0hLLEVBQUUsQ0FBQy9CLElBQUgsS0FBWTBCLFNBRFQsR0FFSEssRUFBRSxLQUFLTCxTQUZYO0FBR0QsR0FKeUIsQ0FBMUI7O0FBTUEsTUFBSUcsaUJBQUosRUFBdUI7QUFDckJqRCxJQUFBQSxNQUFNLENBQUNvRCxNQUFQLENBQWNILGlCQUFkO0FBQ0Q7QUFDRjs7ZUFHY2pELE0iLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgd2luc3RvbiwgeyBmb3JtYXQgfSBmcm9tICd3aW5zdG9uJztcbmltcG9ydCBmcyBmcm9tICdmcyc7XG5pbXBvcnQgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCBEYWlseVJvdGF0ZUZpbGUgZnJvbSAnd2luc3Rvbi1kYWlseS1yb3RhdGUtZmlsZSc7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IGRlZmF1bHRzIGZyb20gJy4uLy4uL2RlZmF1bHRzJztcblxuY29uc3QgbG9nZ2VyID0gd2luc3Rvbi5jcmVhdGVMb2dnZXIoKTtcblxuZnVuY3Rpb24gY29uZmlndXJlVHJhbnNwb3J0cyhvcHRpb25zKSB7XG4gIGNvbnN0IHRyYW5zcG9ydHMgPSBbXTtcbiAgaWYgKG9wdGlvbnMpIHtcbiAgICBjb25zdCBzaWxlbnQgPSBvcHRpb25zLnNpbGVudDtcbiAgICBkZWxldGUgb3B0aW9ucy5zaWxlbnQ7XG5cbiAgICBpZiAoIV8uaXNOaWwob3B0aW9ucy5kaXJuYW1lKSkge1xuICAgICAgY29uc3QgcGFyc2VTZXJ2ZXIgPSBuZXcgRGFpbHlSb3RhdGVGaWxlKFxuICAgICAgICBPYmplY3QuYXNzaWduKFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGZpbGVuYW1lOiAncGFyc2Utc2VydmVyLmluZm8nLFxuICAgICAgICAgICAganNvbjogdHJ1ZSxcbiAgICAgICAgICAgIGZvcm1hdDogZm9ybWF0LmNvbWJpbmUoZm9ybWF0LnRpbWVzdGFtcCgpLCBmb3JtYXQuc3BsYXQoKSwgZm9ybWF0Lmpzb24oKSksXG4gICAgICAgICAgfSxcbiAgICAgICAgICBvcHRpb25zXG4gICAgICAgIClcbiAgICAgICk7XG4gICAgICBwYXJzZVNlcnZlci5uYW1lID0gJ3BhcnNlLXNlcnZlcic7XG4gICAgICB0cmFuc3BvcnRzLnB1c2gocGFyc2VTZXJ2ZXIpO1xuXG4gICAgICBjb25zdCBwYXJzZVNlcnZlckVycm9yID0gbmV3IERhaWx5Um90YXRlRmlsZShcbiAgICAgICAgT2JqZWN0LmFzc2lnbihcbiAgICAgICAgICB7XG4gICAgICAgICAgICBmaWxlbmFtZTogJ3BhcnNlLXNlcnZlci5lcnInLFxuICAgICAgICAgICAganNvbjogdHJ1ZSxcbiAgICAgICAgICAgIGZvcm1hdDogZm9ybWF0LmNvbWJpbmUoXG4gICAgICAgICAgICAgIGZvcm1hdC50aW1lc3RhbXAoKSxcbiAgICAgICAgICAgICAgZm9ybWF0LnNwbGF0KCksXG4gICAgICAgICAgICAgIGZvcm1hdC5qc29uKClcbiAgICAgICAgICAgICksXG4gICAgICAgICAgfSxcbiAgICAgICAgICBvcHRpb25zLFxuICAgICAgICAgIHsgbGV2ZWw6ICdlcnJvcicgfVxuICAgICAgICApXG4gICAgICApO1xuICAgICAgcGFyc2VTZXJ2ZXJFcnJvci5uYW1lID0gJ3BhcnNlLXNlcnZlci1lcnJvcic7XG4gICAgICB0cmFuc3BvcnRzLnB1c2gocGFyc2VTZXJ2ZXJFcnJvcik7XG4gICAgfVxuXG4gICAgY29uc3QgY29uc29sZUZvcm1hdCA9IG9wdGlvbnMuanNvbiA/IGZvcm1hdC5qc29uKCkgOiBmb3JtYXQuc2ltcGxlKCk7XG4gICAgY29uc3QgY29uc29sZU9wdGlvbnMgPSBPYmplY3QuYXNzaWduKFxuICAgICAge1xuICAgICAgICBjb2xvcml6ZTogdHJ1ZSxcbiAgICAgICAgbmFtZTogJ2NvbnNvbGUnLFxuICAgICAgICBzaWxlbnQsXG4gICAgICAgIGZvcm1hdDogY29uc29sZUZvcm1hdCxcbiAgICAgIH0sXG4gICAgICBvcHRpb25zXG4gICAgKTtcblxuICAgIHRyYW5zcG9ydHMucHVzaChuZXcgd2luc3Rvbi50cmFuc3BvcnRzLkNvbnNvbGUoY29uc29sZU9wdGlvbnMpKTtcbiAgfVxuXG4gIGxvZ2dlci5jb25maWd1cmUoe1xuICAgIHRyYW5zcG9ydHMsXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29uZmlndXJlTG9nZ2VyKHtcbiAgbG9nc0ZvbGRlciA9IGRlZmF1bHRzLmxvZ3NGb2xkZXIsXG4gIGpzb25Mb2dzID0gZGVmYXVsdHMuanNvbkxvZ3MsXG4gIGxvZ0xldmVsID0gd2luc3Rvbi5sZXZlbCxcbiAgdmVyYm9zZSA9IGRlZmF1bHRzLnZlcmJvc2UsXG4gIHNpbGVudCA9IGRlZmF1bHRzLnNpbGVudCxcbn0gPSB7fSkge1xuICBpZiAodmVyYm9zZSkge1xuICAgIGxvZ0xldmVsID0gJ3ZlcmJvc2UnO1xuICB9XG5cbiAgd2luc3Rvbi5sZXZlbCA9IGxvZ0xldmVsO1xuICBjb25zdCBvcHRpb25zID0ge307XG5cbiAgaWYgKGxvZ3NGb2xkZXIpIHtcbiAgICBpZiAoIXBhdGguaXNBYnNvbHV0ZShsb2dzRm9sZGVyKSkge1xuICAgICAgbG9nc0ZvbGRlciA9IHBhdGgucmVzb2x2ZShwcm9jZXNzLmN3ZCgpLCBsb2dzRm9sZGVyKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGZzLm1rZGlyU3luYyhsb2dzRm9sZGVyKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAvKiAqL1xuICAgIH1cbiAgfVxuICBvcHRpb25zLmRpcm5hbWUgPSBsb2dzRm9sZGVyO1xuICBvcHRpb25zLmxldmVsID0gbG9nTGV2ZWw7XG4gIG9wdGlvbnMuc2lsZW50ID0gc2lsZW50O1xuXG4gIGlmIChqc29uTG9ncykge1xuICAgIG9wdGlvbnMuanNvbiA9IHRydWU7XG4gICAgb3B0aW9ucy5zdHJpbmdpZnkgPSB0cnVlO1xuICB9XG4gIGNvbmZpZ3VyZVRyYW5zcG9ydHMob3B0aW9ucyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRUcmFuc3BvcnQodHJhbnNwb3J0KSB7XG4gIC8vIHdlIHdpbGwgcmVtb3ZlIHRoZSBleGlzdGluZyB0cmFuc3BvcnRcbiAgLy8gYmVmb3JlIHJlcGxhY2luZyBpdCB3aXRoIGEgbmV3IG9uZVxuICByZW1vdmVUcmFuc3BvcnQodHJhbnNwb3J0Lm5hbWUpO1xuXG4gIGxvZ2dlci5hZGQodHJhbnNwb3J0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZVRyYW5zcG9ydCh0cmFuc3BvcnQpIHtcbiAgY29uc3QgbWF0Y2hpbmdUcmFuc3BvcnQgPSBsb2dnZXIudHJhbnNwb3J0cy5maW5kKHQxID0+IHtcbiAgICByZXR1cm4gdHlwZW9mIHRyYW5zcG9ydCA9PT0gJ3N0cmluZydcbiAgICAgID8gdDEubmFtZSA9PT0gdHJhbnNwb3J0XG4gICAgICA6IHQxID09PSB0cmFuc3BvcnQ7XG4gIH0pO1xuXG4gIGlmIChtYXRjaGluZ1RyYW5zcG9ydCkge1xuICAgIGxvZ2dlci5yZW1vdmUobWF0Y2hpbmdUcmFuc3BvcnQpO1xuICB9XG59XG5cbmV4cG9ydCB7IGxvZ2dlciB9O1xuZXhwb3J0IGRlZmF1bHQgbG9nZ2VyO1xuIl19
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _Options = require("./Options");
var _defaults = _interopRequireDefault(require("./defaults"));
var logging = _interopRequireWildcard(require("./logger"));
var _Config = _interopRequireDefault(require("./Config"));
var _PromiseRouter = _interopRequireDefault(require("./PromiseRouter"));
var _requiredParameter = _interopRequireDefault(require("./requiredParameter"));
var _AnalyticsRouter = require("./Routers/AnalyticsRouter");
var _ClassesRouter = require("./Routers/ClassesRouter");
var _FeaturesRouter = require("./Routers/FeaturesRouter");
var _FilesRouter = require("./Routers/FilesRouter");
var _FunctionsRouter = require("./Routers/FunctionsRouter");
var _GlobalConfigRouter = require("./Routers/GlobalConfigRouter");
var _GraphQLRouter = require("./Routers/GraphQLRouter");
var _HooksRouter = require("./Routers/HooksRouter");
var _IAPValidationRouter = require("./Routers/IAPValidationRouter");
var _InstallationsRouter = require("./Routers/InstallationsRouter");
var _LogsRouter = require("./Routers/LogsRouter");
var _ParseLiveQueryServer = require("./LiveQuery/ParseLiveQueryServer");
var _PagesRouter = require("./Routers/PagesRouter");
var _PublicAPIRouter = require("./Routers/PublicAPIRouter");
var _PushRouter = require("./Routers/PushRouter");
var _CloudCodeRouter = require("./Routers/CloudCodeRouter");
var _RolesRouter = require("./Routers/RolesRouter");
var _SchemasRouter = require("./Routers/SchemasRouter");
var _SessionsRouter = require("./Routers/SessionsRouter");
var _UsersRouter = require("./Routers/UsersRouter");
var _PurgeRouter = require("./Routers/PurgeRouter");
var _AudiencesRouter = require("./Routers/AudiencesRouter");
var _AggregateRouter = require("./Routers/AggregateRouter");
var _ParseServerRESTController = require("./ParseServerRESTController");
var controllers = _interopRequireWildcard(require("./Controllers"));
var _ParseGraphQLServer = require("./GraphQL/ParseGraphQLServer");
var _SecurityRouter = require("./Routers/SecurityRouter");
var _CheckRunner = _interopRequireDefault(require("./Security/CheckRunner"));
var _Deprecator = _interopRequireDefault(require("./Deprecator/Deprecator"));
var _DefinedSchemas = require("./SchemaMigrations/DefinedSchemas");
var _Definitions = _interopRequireDefault(require("./Options/Definitions"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == typeof i ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != typeof t || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != typeof i) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
// ParseServer - open-source compatible API Server for Parse apps

var batch = require('./batch'),
  bodyParser = require('body-parser'),
  express = require('express'),
  middlewares = require('./middlewares'),
  Parse = require('parse/node').Parse,
  {
    parse
  } = require('graphql'),
  path = require('path'),
  fs = require('fs');
// Mutate the Parse object to add the Cloud Code handlers
addParseCloud();

// ParseServer works like a constructor of an express app.
// https://parseplatform.org/parse-server/api/master/ParseServerOptions.html
class ParseServer {
  /**
   * @constructor
   * @param {ParseServerOptions} options the parse server initialization options
   */
  constructor(options) {
    // Scan for deprecated Parse Server options
    _Deprecator.default.scanParseServerOptions(options);
    const interfaces = JSON.parse(JSON.stringify(_Definitions.default));
    function getValidObject(root) {
      const result = {};
      for (const key in root) {
        if (Object.prototype.hasOwnProperty.call(root[key], 'type')) {
          if (root[key].type.endsWith('[]')) {
            result[key] = [getValidObject(interfaces[root[key].type.slice(0, -2)])];
          } else {
            result[key] = getValidObject(interfaces[root[key].type]);
          }
        } else {
          result[key] = '';
        }
      }
      return result;
    }
    const optionsBlueprint = getValidObject(interfaces['ParseServerOptions']);
    function validateKeyNames(original, ref, name = '') {
      let result = [];
      const prefix = name + (name !== '' ? '.' : '');
      for (const key in original) {
        if (!Object.prototype.hasOwnProperty.call(ref, key)) {
          result.push(prefix + key);
        } else {
          if (ref[key] === '') {
            continue;
          }
          let res = [];
          if (Array.isArray(original[key]) && Array.isArray(ref[key])) {
            const type = ref[key][0];
            original[key].forEach((item, idx) => {
              if (typeof item === 'object' && item !== null) {
                res = res.concat(validateKeyNames(item, type, prefix + key + `[${idx}]`));
              }
            });
          } else if (typeof original[key] === 'object' && typeof ref[key] === 'object') {
            res = validateKeyNames(original[key], ref[key], prefix + key);
          }
          result = result.concat(res);
        }
      }
      return result;
    }
    const diff = validateKeyNames(options, optionsBlueprint);
    if (diff.length > 0) {
      const logger = logging.logger;
      logger.error(`Invalid key(s) found in Parse Server configuration: ${diff.join(', ')}`);
    }

    // Set option defaults
    injectDefaults(options);
    const {
      appId = (0, _requiredParameter.default)('You must provide an appId!'),
      masterKey = (0, _requiredParameter.default)('You must provide a masterKey!'),
      javascriptKey,
      serverURL = (0, _requiredParameter.default)('You must provide a serverURL!')
    } = options;
    // Initialize the node client SDK automatically
    Parse.initialize(appId, javascriptKey || 'unused', masterKey);
    Parse.serverURL = serverURL;
    _Config.default.validateOptions(options);
    const allControllers = controllers.getControllers(options);
    options.state = 'initialized';
    this.config = _Config.default.put(Object.assign({}, options, allControllers));
    this.config.masterKeyIpsStore = new Map();
    this.config.maintenanceKeyIpsStore = new Map();
    logging.setLogger(allControllers.loggerController);
  }

  /**
   * Starts Parse Server as an express app; this promise resolves when Parse Server is ready to accept requests.
   */

  async start() {
    try {
      var _cacheController$adap;
      if (this.config.state === 'ok') {
        return this;
      }
      this.config.state = 'starting';
      _Config.default.put(this.config);
      const {
        databaseController,
        hooksController,
        cacheController,
        cloud,
        security,
        schema,
        liveQueryController
      } = this.config;
      try {
        await databaseController.performInitialization();
      } catch (e) {
        if (e.code !== Parse.Error.DUPLICATE_VALUE) {
          throw e;
        }
      }
      const pushController = await controllers.getPushController(this.config);
      await hooksController.load();
      const startupPromises = [];
      if (schema) {
        startupPromises.push(new _DefinedSchemas.DefinedSchemas(schema, this.config).execute());
      }
      if ((_cacheController$adap = cacheController.adapter) !== null && _cacheController$adap !== void 0 && _cacheController$adap.connect && typeof cacheController.adapter.connect === 'function') {
        startupPromises.push(cacheController.adapter.connect());
      }
      startupPromises.push(liveQueryController.connect());
      await Promise.all(startupPromises);
      if (cloud) {
        addParseCloud();
        if (typeof cloud === 'function') {
          await Promise.resolve(cloud(Parse));
        } else if (typeof cloud === 'string') {
          var _json;
          let json;
          if (process.env.npm_package_json) {
            json = require(process.env.npm_package_json);
          }
          if (process.env.npm_package_type === 'module' || ((_json = json) === null || _json === void 0 ? void 0 : _json.type) === 'module') {
            await import(path.resolve(process.cwd(), cloud));
          } else {
            require(path.resolve(process.cwd(), cloud));
          }
        } else {
          throw "argument 'cloud' must either be a string or a function";
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (security && security.enableCheck && security.enableCheckLog) {
        new _CheckRunner.default(security).run();
      }
      this.config.state = 'ok';
      this.config = _objectSpread(_objectSpread({}, this.config), pushController);
      _Config.default.put(this.config);
      return this;
    } catch (error) {
      console.error(error);
      this.config.state = 'error';
      throw error;
    }
  }
  get app() {
    if (!this._app) {
      this._app = ParseServer.app(this.config);
    }
    return this._app;
  }
  handleShutdown() {
    var _this$liveQueryServer;
    const promises = [];
    const {
      adapter: databaseAdapter
    } = this.config.databaseController;
    if (databaseAdapter && typeof databaseAdapter.handleShutdown === 'function') {
      promises.push(databaseAdapter.handleShutdown());
    }
    const {
      adapter: fileAdapter
    } = this.config.filesController;
    if (fileAdapter && typeof fileAdapter.handleShutdown === 'function') {
      promises.push(fileAdapter.handleShutdown());
    }
    const {
      adapter: cacheAdapter
    } = this.config.cacheController;
    if (cacheAdapter && typeof cacheAdapter.handleShutdown === 'function') {
      promises.push(cacheAdapter.handleShutdown());
    }
    if ((_this$liveQueryServer = this.liveQueryServer) !== null && _this$liveQueryServer !== void 0 && (_this$liveQueryServer = _this$liveQueryServer.server) !== null && _this$liveQueryServer !== void 0 && _this$liveQueryServer.close) {
      promises.push(new Promise(resolve => this.liveQueryServer.server.close(resolve)));
    }
    if (this.liveQueryServer) {
      promises.push(this.liveQueryServer.shutdown());
    }
    return (promises.length > 0 ? Promise.all(promises) : Promise.resolve()).then(() => {
      if (this.config.serverCloseComplete) {
        this.config.serverCloseComplete();
      }
    });
  }

  /**
   * @static
   * Create an express app for the parse server
   * @param {Object} options let you specify the maxUploadSize when creating the express app  */
  static app(options) {
    const {
      maxUploadSize = '20mb',
      appId,
      directAccess,
      pages,
      rateLimit = []
    } = options;
    // This app serves the Parse API directly.
    // It's the equivalent of https://api.parse.com/1 in the hosted Parse API.
    var api = express();
    //api.use("/apps", express.static(__dirname + "/public"));
    api.use(middlewares.allowCrossDomain(appId));
    // File handling needs to be before default middlewares are applied
    api.use('/', new _FilesRouter.FilesRouter().expressRouter({
      maxUploadSize: maxUploadSize
    }));
    api.use('/health', function (req, res) {
      res.status(options.state === 'ok' ? 200 : 503);
      if (options.state === 'starting') {
        res.set('Retry-After', 1);
      }
      res.json({
        status: options.state
      });
    });
    api.use('/', bodyParser.urlencoded({
      extended: false
    }), pages.enableRouter ? new _PagesRouter.PagesRouter(pages).expressRouter() : new _PublicAPIRouter.PublicAPIRouter().expressRouter());
    api.use(bodyParser.json({
      type: '*/*',
      limit: maxUploadSize
    }));
    api.use(middlewares.allowMethodOverride);
    api.use(middlewares.handleParseHeaders);
    const routes = Array.isArray(rateLimit) ? rateLimit : [rateLimit];
    for (const route of routes) {
      middlewares.addRateLimit(route, options);
    }
    api.use(middlewares.handleParseSession);
    const appRouter = ParseServer.promiseRouter({
      appId
    });
    api.use(appRouter.expressRouter());
    api.use(middlewares.handleParseErrors);

    // run the following when not testing
    if (!process.env.TESTING) {
      //This causes tests to spew some useless warnings, so disable in test
      /* istanbul ignore next */
      process.on('uncaughtException', err => {
        if (err.code === 'EADDRINUSE') {
          // user-friendly message for this common error
          process.stderr.write(`Unable to listen on port ${err.port}. The port is already in use.`);
          process.exit(0);
        } else {
          if (err.message) {
            process.stderr.write('An uncaught exception occurred: ' + err.message);
          }
          if (err.stack) {
            process.stderr.write('Stack Trace:\n' + err.stack);
          } else {
            process.stderr.write(err);
          }
          process.exit(1);
        }
      });
      // verify the server url after a 'mount' event is received
      /* istanbul ignore next */
      api.on('mount', async function () {
        await new Promise(resolve => setTimeout(resolve, 1000));
        ParseServer.verifyServerUrl();
      });
    }
    if (process.env.PARSE_SERVER_ENABLE_EXPERIMENTAL_DIRECT_ACCESS === '1' || directAccess) {
      Parse.CoreManager.setRESTController((0, _ParseServerRESTController.ParseServerRESTController)(appId, appRouter));
    }
    return api;
  }
  static promiseRouter({
    appId
  }) {
    const routers = [new _ClassesRouter.ClassesRouter(), new _UsersRouter.UsersRouter(), new _SessionsRouter.SessionsRouter(), new _RolesRouter.RolesRouter(), new _AnalyticsRouter.AnalyticsRouter(), new _InstallationsRouter.InstallationsRouter(), new _FunctionsRouter.FunctionsRouter(), new _SchemasRouter.SchemasRouter(), new _PushRouter.PushRouter(), new _LogsRouter.LogsRouter(), new _IAPValidationRouter.IAPValidationRouter(), new _FeaturesRouter.FeaturesRouter(), new _GlobalConfigRouter.GlobalConfigRouter(), new _GraphQLRouter.GraphQLRouter(), new _PurgeRouter.PurgeRouter(), new _HooksRouter.HooksRouter(), new _CloudCodeRouter.CloudCodeRouter(), new _AudiencesRouter.AudiencesRouter(), new _AggregateRouter.AggregateRouter(), new _SecurityRouter.SecurityRouter()];
    const routes = routers.reduce((memo, router) => {
      return memo.concat(router.routes);
    }, []);
    const appRouter = new _PromiseRouter.default(routes, appId);
    batch.mountOnto(appRouter);
    return appRouter;
  }

  /**
   * starts the parse server's express app
   * @param {ParseServerOptions} options to use to start the server
   * @returns {ParseServer} the parse server instance
   */

  async startApp(options) {
    try {
      await this.start();
    } catch (e) {
      console.error('Error on ParseServer.startApp: ', e);
      throw e;
    }
    const app = express();
    if (options.middleware) {
      let middleware;
      if (typeof options.middleware == 'string') {
        middleware = require(path.resolve(process.cwd(), options.middleware));
      } else {
        middleware = options.middleware; // use as-is let express fail
      }
      app.use(middleware);
    }
    app.use(options.mountPath, this.app);
    if (options.mountGraphQL === true || options.mountPlayground === true) {
      let graphQLCustomTypeDefs = undefined;
      if (typeof options.graphQLSchema === 'string') {
        graphQLCustomTypeDefs = parse(fs.readFileSync(options.graphQLSchema, 'utf8'));
      } else if (typeof options.graphQLSchema === 'object' || typeof options.graphQLSchema === 'function') {
        graphQLCustomTypeDefs = options.graphQLSchema;
      }
      const parseGraphQLServer = new _ParseGraphQLServer.ParseGraphQLServer(this, {
        graphQLPath: options.graphQLPath,
        playgroundPath: options.playgroundPath,
        graphQLCustomTypeDefs
      });
      if (options.mountGraphQL) {
        parseGraphQLServer.applyGraphQL(app);
      }
      if (options.mountPlayground) {
        parseGraphQLServer.applyPlayground(app);
      }
    }
    const server = await new Promise(resolve => {
      app.listen(options.port, options.host, function () {
        resolve(this);
      });
    });
    this.server = server;
    if (options.startLiveQueryServer || options.liveQueryServerOptions) {
      this.liveQueryServer = await ParseServer.createLiveQueryServer(server, options.liveQueryServerOptions, options);
    }
    if (options.trustProxy) {
      app.set('trust proxy', options.trustProxy);
    }
    /* istanbul ignore next */
    if (!process.env.TESTING) {
      configureListeners(this);
    }
    this.expressApp = app;
    return this;
  }

  /**
   * Creates a new ParseServer and starts it.
   * @param {ParseServerOptions} options used to start the server
   * @returns {ParseServer} the parse server instance
   */
  static async startApp(options) {
    const parseServer = new ParseServer(options);
    return parseServer.startApp(options);
  }

  /**
   * Helper method to create a liveQuery server
   * @static
   * @param {Server} httpServer an optional http server to pass
   * @param {LiveQueryServerOptions} config options for the liveQueryServer
   * @param {ParseServerOptions} options options for the ParseServer
   * @returns {Promise<ParseLiveQueryServer>} the live query server instance
   */
  static async createLiveQueryServer(httpServer, config, options) {
    if (!httpServer || config && config.port) {
      var app = express();
      httpServer = require('http').createServer(app);
      httpServer.listen(config.port);
    }
    const server = new _ParseLiveQueryServer.ParseLiveQueryServer(httpServer, config, options);
    await server.connect();
    return server;
  }
  static async verifyServerUrl() {
    // perform a health check on the serverURL value
    if (Parse.serverURL) {
      var _response$headers;
      const isValidHttpUrl = string => {
        let url;
        try {
          url = new URL(string);
        } catch (_) {
          return false;
        }
        return url.protocol === 'http:' || url.protocol === 'https:';
      };
      const url = `${Parse.serverURL.replace(/\/$/, '')}/health`;
      if (!isValidHttpUrl(url)) {
        console.warn(`\nWARNING, Unable to connect to '${Parse.serverURL}' as the URL is invalid.` + ` Cloud code and push notifications may be unavailable!\n`);
        return;
      }
      const request = require('./request');
      const response = await request({
        url
      }).catch(response => response);
      const json = response.data || null;
      const retry = (_response$headers = response.headers) === null || _response$headers === void 0 ? void 0 : _response$headers['retry-after'];
      if (retry) {
        await new Promise(resolve => setTimeout(resolve, retry * 1000));
        return this.verifyServerUrl();
      }
      if (response.status !== 200 || (json === null || json === void 0 ? void 0 : json.status) !== 'ok') {
        /* eslint-disable no-console */
        console.warn(`\nWARNING, Unable to connect to '${Parse.serverURL}'.` + ` Cloud code and push notifications may be unavailable!\n`);
        /* eslint-enable no-console */
        return;
      }
      return true;
    }
  }
}
function addParseCloud() {
  const ParseCloud = require('./cloud-code/Parse.Cloud');
  const ParseServer = require('./cloud-code/Parse.Server');
  Object.defineProperty(Parse, 'Server', {
    get() {
      const conf = _Config.default.get(Parse.applicationId);
      return _objectSpread(_objectSpread({}, conf), ParseServer);
    },
    set(newVal) {
      newVal.appId = Parse.applicationId;
      _Config.default.put(newVal);
    },
    configurable: true
  });
  Object.assign(Parse.Cloud, ParseCloud);
  global.Parse = Parse;
}
function injectDefaults(options) {
  Object.keys(_defaults.default).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(options, key)) {
      options[key] = _defaults.default[key];
    }
  });
  if (!Object.prototype.hasOwnProperty.call(options, 'serverURL')) {
    options.serverURL = `http://localhost:${options.port}${options.mountPath}`;
  }

  // Reserved Characters
  if (options.appId) {
    const regex = /[!#$%'()*+&/:;=?@[\]{}^,|<>]/g;
    if (options.appId.match(regex)) {
      console.warn(`\nWARNING, appId that contains special characters can cause issues while using with urls.\n`);
    }
  }

  // Backwards compatibility
  if (options.userSensitiveFields) {
    /* eslint-disable no-console */
    !process.env.TESTING && console.warn(`\nDEPRECATED: userSensitiveFields has been replaced by protectedFields allowing the ability to protect fields in all classes with CLP. \n`);
    /* eslint-enable no-console */

    const userSensitiveFields = Array.from(new Set([...(_defaults.default.userSensitiveFields || []), ...(options.userSensitiveFields || [])]));

    // If the options.protectedFields is unset,
    // it'll be assigned the default above.
    // Here, protect against the case where protectedFields
    // is set, but doesn't have _User.
    if (!('_User' in options.protectedFields)) {
      options.protectedFields = Object.assign({
        _User: []
      }, options.protectedFields);
    }
    options.protectedFields['_User']['*'] = Array.from(new Set([...(options.protectedFields['_User']['*'] || []), ...userSensitiveFields]));
  }

  // Merge protectedFields options with defaults.
  Object.keys(_defaults.default.protectedFields).forEach(c => {
    const cur = options.protectedFields[c];
    if (!cur) {
      options.protectedFields[c] = _defaults.default.protectedFields[c];
    } else {
      Object.keys(_defaults.default.protectedFields[c]).forEach(r => {
        const unq = new Set([...(options.protectedFields[c][r] || []), ..._defaults.default.protectedFields[c][r]]);
        options.protectedFields[c][r] = Array.from(unq);
      });
    }
  });
}

// Those can't be tested as it requires a subprocess
/* istanbul ignore next */
function configureListeners(parseServer) {
  const server = parseServer.server;
  const sockets = {};
  /* Currently, express doesn't shut down immediately after receiving SIGINT/SIGTERM if it has client connections that haven't timed out. (This is a known issue with node - https://github.com/nodejs/node/issues/2642)
    This function, along with `destroyAliveConnections()`, intend to fix this behavior such that parse server will close all open connections and initiate the shutdown process as soon as it receives a SIGINT/SIGTERM signal. */
  server.on('connection', socket => {
    const socketId = socket.remoteAddress + ':' + socket.remotePort;
    sockets[socketId] = socket;
    socket.on('close', () => {
      delete sockets[socketId];
    });
  });
  const destroyAliveConnections = function () {
    for (const socketId in sockets) {
      try {
        sockets[socketId].destroy();
      } catch (e) {
        /* */
      }
    }
  };
  const handleShutdown = function () {
    process.stdout.write('Termination signal received. Shutting down.');
    destroyAliveConnections();
    server.close();
    parseServer.handleShutdown();
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}
var _default = exports.default = ParseServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfT3B0aW9ucyIsInJlcXVpcmUiLCJfZGVmYXVsdHMiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwibG9nZ2luZyIsIl9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkIiwiX0NvbmZpZyIsIl9Qcm9taXNlUm91dGVyIiwiX3JlcXVpcmVkUGFyYW1ldGVyIiwiX0FuYWx5dGljc1JvdXRlciIsIl9DbGFzc2VzUm91dGVyIiwiX0ZlYXR1cmVzUm91dGVyIiwiX0ZpbGVzUm91dGVyIiwiX0Z1bmN0aW9uc1JvdXRlciIsIl9HbG9iYWxDb25maWdSb3V0ZXIiLCJfR3JhcGhRTFJvdXRlciIsIl9Ib29rc1JvdXRlciIsIl9JQVBWYWxpZGF0aW9uUm91dGVyIiwiX0luc3RhbGxhdGlvbnNSb3V0ZXIiLCJfTG9nc1JvdXRlciIsIl9QYXJzZUxpdmVRdWVyeVNlcnZlciIsIl9QYWdlc1JvdXRlciIsIl9QdWJsaWNBUElSb3V0ZXIiLCJfUHVzaFJvdXRlciIsIl9DbG91ZENvZGVSb3V0ZXIiLCJfUm9sZXNSb3V0ZXIiLCJfU2NoZW1hc1JvdXRlciIsIl9TZXNzaW9uc1JvdXRlciIsIl9Vc2Vyc1JvdXRlciIsIl9QdXJnZVJvdXRlciIsIl9BdWRpZW5jZXNSb3V0ZXIiLCJfQWdncmVnYXRlUm91dGVyIiwiX1BhcnNlU2VydmVyUkVTVENvbnRyb2xsZXIiLCJjb250cm9sbGVycyIsIl9QYXJzZUdyYXBoUUxTZXJ2ZXIiLCJfU2VjdXJpdHlSb3V0ZXIiLCJfQ2hlY2tSdW5uZXIiLCJfRGVwcmVjYXRvciIsIl9EZWZpbmVkU2NoZW1hcyIsIl9EZWZpbml0aW9ucyIsIl9nZXRSZXF1aXJlV2lsZGNhcmRDYWNoZSIsImUiLCJXZWFrTWFwIiwiciIsInQiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsImhhcyIsImdldCIsIm4iLCJfX3Byb3RvX18iLCJhIiwiT2JqZWN0IiwiZGVmaW5lUHJvcGVydHkiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IiLCJ1IiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiaSIsInNldCIsIm93bktleXMiLCJrZXlzIiwiZ2V0T3duUHJvcGVydHlTeW1ib2xzIiwibyIsImZpbHRlciIsImVudW1lcmFibGUiLCJwdXNoIiwiYXBwbHkiLCJfb2JqZWN0U3ByZWFkIiwiYXJndW1lbnRzIiwibGVuZ3RoIiwiZm9yRWFjaCIsIl9kZWZpbmVQcm9wZXJ0eSIsImdldE93blByb3BlcnR5RGVzY3JpcHRvcnMiLCJkZWZpbmVQcm9wZXJ0aWVzIiwiX3RvUHJvcGVydHlLZXkiLCJ2YWx1ZSIsImNvbmZpZ3VyYWJsZSIsIndyaXRhYmxlIiwiX3RvUHJpbWl0aXZlIiwiU3ltYm9sIiwidG9QcmltaXRpdmUiLCJUeXBlRXJyb3IiLCJTdHJpbmciLCJOdW1iZXIiLCJiYXRjaCIsImJvZHlQYXJzZXIiLCJleHByZXNzIiwibWlkZGxld2FyZXMiLCJQYXJzZSIsInBhcnNlIiwicGF0aCIsImZzIiwiYWRkUGFyc2VDbG91ZCIsIlBhcnNlU2VydmVyIiwiY29uc3RydWN0b3IiLCJvcHRpb25zIiwiRGVwcmVjYXRvciIsInNjYW5QYXJzZVNlcnZlck9wdGlvbnMiLCJpbnRlcmZhY2VzIiwiSlNPTiIsInN0cmluZ2lmeSIsIk9wdGlvbnNEZWZpbml0aW9ucyIsImdldFZhbGlkT2JqZWN0Iiwicm9vdCIsInJlc3VsdCIsImtleSIsInByb3RvdHlwZSIsInR5cGUiLCJlbmRzV2l0aCIsInNsaWNlIiwib3B0aW9uc0JsdWVwcmludCIsInZhbGlkYXRlS2V5TmFtZXMiLCJvcmlnaW5hbCIsInJlZiIsIm5hbWUiLCJwcmVmaXgiLCJyZXMiLCJBcnJheSIsImlzQXJyYXkiLCJpdGVtIiwiaWR4IiwiY29uY2F0IiwiZGlmZiIsImxvZ2dlciIsImVycm9yIiwiam9pbiIsImluamVjdERlZmF1bHRzIiwiYXBwSWQiLCJyZXF1aXJlZFBhcmFtZXRlciIsIm1hc3RlcktleSIsImphdmFzY3JpcHRLZXkiLCJzZXJ2ZXJVUkwiLCJpbml0aWFsaXplIiwiQ29uZmlnIiwidmFsaWRhdGVPcHRpb25zIiwiYWxsQ29udHJvbGxlcnMiLCJnZXRDb250cm9sbGVycyIsInN0YXRlIiwiY29uZmlnIiwicHV0IiwiYXNzaWduIiwibWFzdGVyS2V5SXBzU3RvcmUiLCJNYXAiLCJtYWludGVuYW5jZUtleUlwc1N0b3JlIiwic2V0TG9nZ2VyIiwibG9nZ2VyQ29udHJvbGxlciIsInN0YXJ0IiwiX2NhY2hlQ29udHJvbGxlciRhZGFwIiwiZGF0YWJhc2VDb250cm9sbGVyIiwiaG9va3NDb250cm9sbGVyIiwiY2FjaGVDb250cm9sbGVyIiwiY2xvdWQiLCJzZWN1cml0eSIsInNjaGVtYSIsImxpdmVRdWVyeUNvbnRyb2xsZXIiLCJwZXJmb3JtSW5pdGlhbGl6YXRpb24iLCJjb2RlIiwiRXJyb3IiLCJEVVBMSUNBVEVfVkFMVUUiLCJwdXNoQ29udHJvbGxlciIsImdldFB1c2hDb250cm9sbGVyIiwibG9hZCIsInN0YXJ0dXBQcm9taXNlcyIsIkRlZmluZWRTY2hlbWFzIiwiZXhlY3V0ZSIsImFkYXB0ZXIiLCJjb25uZWN0IiwiUHJvbWlzZSIsImFsbCIsInJlc29sdmUiLCJfanNvbiIsImpzb24iLCJwcm9jZXNzIiwiZW52IiwibnBtX3BhY2thZ2VfanNvbiIsIm5wbV9wYWNrYWdlX3R5cGUiLCJjd2QiLCJzZXRUaW1lb3V0IiwiZW5hYmxlQ2hlY2siLCJlbmFibGVDaGVja0xvZyIsIkNoZWNrUnVubmVyIiwicnVuIiwiY29uc29sZSIsImFwcCIsIl9hcHAiLCJoYW5kbGVTaHV0ZG93biIsIl90aGlzJGxpdmVRdWVyeVNlcnZlciIsInByb21pc2VzIiwiZGF0YWJhc2VBZGFwdGVyIiwiZmlsZUFkYXB0ZXIiLCJmaWxlc0NvbnRyb2xsZXIiLCJjYWNoZUFkYXB0ZXIiLCJsaXZlUXVlcnlTZXJ2ZXIiLCJzZXJ2ZXIiLCJjbG9zZSIsInNodXRkb3duIiwidGhlbiIsInNlcnZlckNsb3NlQ29tcGxldGUiLCJtYXhVcGxvYWRTaXplIiwiZGlyZWN0QWNjZXNzIiwicGFnZXMiLCJyYXRlTGltaXQiLCJhcGkiLCJ1c2UiLCJhbGxvd0Nyb3NzRG9tYWluIiwiRmlsZXNSb3V0ZXIiLCJleHByZXNzUm91dGVyIiwicmVxIiwic3RhdHVzIiwidXJsZW5jb2RlZCIsImV4dGVuZGVkIiwiZW5hYmxlUm91dGVyIiwiUGFnZXNSb3V0ZXIiLCJQdWJsaWNBUElSb3V0ZXIiLCJsaW1pdCIsImFsbG93TWV0aG9kT3ZlcnJpZGUiLCJoYW5kbGVQYXJzZUhlYWRlcnMiLCJyb3V0ZXMiLCJyb3V0ZSIsImFkZFJhdGVMaW1pdCIsImhhbmRsZVBhcnNlU2Vzc2lvbiIsImFwcFJvdXRlciIsInByb21pc2VSb3V0ZXIiLCJoYW5kbGVQYXJzZUVycm9ycyIsIlRFU1RJTkciLCJvbiIsImVyciIsInN0ZGVyciIsIndyaXRlIiwicG9ydCIsImV4aXQiLCJtZXNzYWdlIiwic3RhY2siLCJ2ZXJpZnlTZXJ2ZXJVcmwiLCJQQVJTRV9TRVJWRVJfRU5BQkxFX0VYUEVSSU1FTlRBTF9ESVJFQ1RfQUNDRVNTIiwiQ29yZU1hbmFnZXIiLCJzZXRSRVNUQ29udHJvbGxlciIsIlBhcnNlU2VydmVyUkVTVENvbnRyb2xsZXIiLCJyb3V0ZXJzIiwiQ2xhc3Nlc1JvdXRlciIsIlVzZXJzUm91dGVyIiwiU2Vzc2lvbnNSb3V0ZXIiLCJSb2xlc1JvdXRlciIsIkFuYWx5dGljc1JvdXRlciIsIkluc3RhbGxhdGlvbnNSb3V0ZXIiLCJGdW5jdGlvbnNSb3V0ZXIiLCJTY2hlbWFzUm91dGVyIiwiUHVzaFJvdXRlciIsIkxvZ3NSb3V0ZXIiLCJJQVBWYWxpZGF0aW9uUm91dGVyIiwiRmVhdHVyZXNSb3V0ZXIiLCJHbG9iYWxDb25maWdSb3V0ZXIiLCJHcmFwaFFMUm91dGVyIiwiUHVyZ2VSb3V0ZXIiLCJIb29rc1JvdXRlciIsIkNsb3VkQ29kZVJvdXRlciIsIkF1ZGllbmNlc1JvdXRlciIsIkFnZ3JlZ2F0ZVJvdXRlciIsIlNlY3VyaXR5Um91dGVyIiwicmVkdWNlIiwibWVtbyIsInJvdXRlciIsIlByb21pc2VSb3V0ZXIiLCJtb3VudE9udG8iLCJzdGFydEFwcCIsIm1pZGRsZXdhcmUiLCJtb3VudFBhdGgiLCJtb3VudEdyYXBoUUwiLCJtb3VudFBsYXlncm91bmQiLCJncmFwaFFMQ3VzdG9tVHlwZURlZnMiLCJ1bmRlZmluZWQiLCJncmFwaFFMU2NoZW1hIiwicmVhZEZpbGVTeW5jIiwicGFyc2VHcmFwaFFMU2VydmVyIiwiUGFyc2VHcmFwaFFMU2VydmVyIiwiZ3JhcGhRTFBhdGgiLCJwbGF5Z3JvdW5kUGF0aCIsImFwcGx5R3JhcGhRTCIsImFwcGx5UGxheWdyb3VuZCIsImxpc3RlbiIsImhvc3QiLCJzdGFydExpdmVRdWVyeVNlcnZlciIsImxpdmVRdWVyeVNlcnZlck9wdGlvbnMiLCJjcmVhdGVMaXZlUXVlcnlTZXJ2ZXIiLCJ0cnVzdFByb3h5IiwiY29uZmlndXJlTGlzdGVuZXJzIiwiZXhwcmVzc0FwcCIsInBhcnNlU2VydmVyIiwiaHR0cFNlcnZlciIsImNyZWF0ZVNlcnZlciIsIlBhcnNlTGl2ZVF1ZXJ5U2VydmVyIiwiX3Jlc3BvbnNlJGhlYWRlcnMiLCJpc1ZhbGlkSHR0cFVybCIsInN0cmluZyIsInVybCIsIlVSTCIsIl8iLCJwcm90b2NvbCIsInJlcGxhY2UiLCJ3YXJuIiwicmVxdWVzdCIsInJlc3BvbnNlIiwiY2F0Y2giLCJkYXRhIiwicmV0cnkiLCJoZWFkZXJzIiwiUGFyc2VDbG91ZCIsImNvbmYiLCJhcHBsaWNhdGlvbklkIiwibmV3VmFsIiwiQ2xvdWQiLCJnbG9iYWwiLCJkZWZhdWx0cyIsInJlZ2V4IiwibWF0Y2giLCJ1c2VyU2Vuc2l0aXZlRmllbGRzIiwiZnJvbSIsIlNldCIsInByb3RlY3RlZEZpZWxkcyIsIl9Vc2VyIiwiYyIsImN1ciIsInVucSIsInNvY2tldHMiLCJzb2NrZXQiLCJzb2NrZXRJZCIsInJlbW90ZUFkZHJlc3MiLCJyZW1vdGVQb3J0IiwiZGVzdHJveUFsaXZlQ29ubmVjdGlvbnMiLCJkZXN0cm95Iiwic3Rkb3V0IiwiX2RlZmF1bHQiLCJleHBvcnRzIl0sInNvdXJjZXMiOlsiLi4vc3JjL1BhcnNlU2VydmVyLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFBhcnNlU2VydmVyIC0gb3Blbi1zb3VyY2UgY29tcGF0aWJsZSBBUEkgU2VydmVyIGZvciBQYXJzZSBhcHBzXG5cbnZhciBiYXRjaCA9IHJlcXVpcmUoJy4vYmF0Y2gnKSxcbiAgYm9keVBhcnNlciA9IHJlcXVpcmUoJ2JvZHktcGFyc2VyJyksXG4gIGV4cHJlc3MgPSByZXF1aXJlKCdleHByZXNzJyksXG4gIG1pZGRsZXdhcmVzID0gcmVxdWlyZSgnLi9taWRkbGV3YXJlcycpLFxuICBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKS5QYXJzZSxcbiAgeyBwYXJzZSB9ID0gcmVxdWlyZSgnZ3JhcGhxbCcpLFxuICBwYXRoID0gcmVxdWlyZSgncGF0aCcpLFxuICBmcyA9IHJlcXVpcmUoJ2ZzJyk7XG5cbmltcG9ydCB7IFBhcnNlU2VydmVyT3B0aW9ucywgTGl2ZVF1ZXJ5U2VydmVyT3B0aW9ucyB9IGZyb20gJy4vT3B0aW9ucyc7XG5pbXBvcnQgZGVmYXVsdHMgZnJvbSAnLi9kZWZhdWx0cyc7XG5pbXBvcnQgKiBhcyBsb2dnaW5nIGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCBDb25maWcgZnJvbSAnLi9Db25maWcnO1xuaW1wb3J0IFByb21pc2VSb3V0ZXIgZnJvbSAnLi9Qcm9taXNlUm91dGVyJztcbmltcG9ydCByZXF1aXJlZFBhcmFtZXRlciBmcm9tICcuL3JlcXVpcmVkUGFyYW1ldGVyJztcbmltcG9ydCB7IEFuYWx5dGljc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9BbmFseXRpY3NSb3V0ZXInO1xuaW1wb3J0IHsgQ2xhc3Nlc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9DbGFzc2VzUm91dGVyJztcbmltcG9ydCB7IEZlYXR1cmVzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0ZlYXR1cmVzUm91dGVyJztcbmltcG9ydCB7IEZpbGVzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0ZpbGVzUm91dGVyJztcbmltcG9ydCB7IEZ1bmN0aW9uc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9GdW5jdGlvbnNSb3V0ZXInO1xuaW1wb3J0IHsgR2xvYmFsQ29uZmlnUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0dsb2JhbENvbmZpZ1JvdXRlcic7XG5pbXBvcnQgeyBHcmFwaFFMUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0dyYXBoUUxSb3V0ZXInO1xuaW1wb3J0IHsgSG9va3NSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvSG9va3NSb3V0ZXInO1xuaW1wb3J0IHsgSUFQVmFsaWRhdGlvblJvdXRlciB9IGZyb20gJy4vUm91dGVycy9JQVBWYWxpZGF0aW9uUm91dGVyJztcbmltcG9ydCB7IEluc3RhbGxhdGlvbnNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvSW5zdGFsbGF0aW9uc1JvdXRlcic7XG5pbXBvcnQgeyBMb2dzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0xvZ3NSb3V0ZXInO1xuaW1wb3J0IHsgUGFyc2VMaXZlUXVlcnlTZXJ2ZXIgfSBmcm9tICcuL0xpdmVRdWVyeS9QYXJzZUxpdmVRdWVyeVNlcnZlcic7XG5pbXBvcnQgeyBQYWdlc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9QYWdlc1JvdXRlcic7XG5pbXBvcnQgeyBQdWJsaWNBUElSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvUHVibGljQVBJUm91dGVyJztcbmltcG9ydCB7IFB1c2hSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvUHVzaFJvdXRlcic7XG5pbXBvcnQgeyBDbG91ZENvZGVSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvQ2xvdWRDb2RlUm91dGVyJztcbmltcG9ydCB7IFJvbGVzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL1JvbGVzUm91dGVyJztcbmltcG9ydCB7IFNjaGVtYXNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvU2NoZW1hc1JvdXRlcic7XG5pbXBvcnQgeyBTZXNzaW9uc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9TZXNzaW9uc1JvdXRlcic7XG5pbXBvcnQgeyBVc2Vyc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9Vc2Vyc1JvdXRlcic7XG5pbXBvcnQgeyBQdXJnZVJvdXRlciB9IGZyb20gJy4vUm91dGVycy9QdXJnZVJvdXRlcic7XG5pbXBvcnQgeyBBdWRpZW5jZXNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvQXVkaWVuY2VzUm91dGVyJztcbmltcG9ydCB7IEFnZ3JlZ2F0ZVJvdXRlciB9IGZyb20gJy4vUm91dGVycy9BZ2dyZWdhdGVSb3V0ZXInO1xuaW1wb3J0IHsgUGFyc2VTZXJ2ZXJSRVNUQ29udHJvbGxlciB9IGZyb20gJy4vUGFyc2VTZXJ2ZXJSRVNUQ29udHJvbGxlcic7XG5pbXBvcnQgKiBhcyBjb250cm9sbGVycyBmcm9tICcuL0NvbnRyb2xsZXJzJztcbmltcG9ydCB7IFBhcnNlR3JhcGhRTFNlcnZlciB9IGZyb20gJy4vR3JhcGhRTC9QYXJzZUdyYXBoUUxTZXJ2ZXInO1xuaW1wb3J0IHsgU2VjdXJpdHlSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvU2VjdXJpdHlSb3V0ZXInO1xuaW1wb3J0IENoZWNrUnVubmVyIGZyb20gJy4vU2VjdXJpdHkvQ2hlY2tSdW5uZXInO1xuaW1wb3J0IERlcHJlY2F0b3IgZnJvbSAnLi9EZXByZWNhdG9yL0RlcHJlY2F0b3InO1xuaW1wb3J0IHsgRGVmaW5lZFNjaGVtYXMgfSBmcm9tICcuL1NjaGVtYU1pZ3JhdGlvbnMvRGVmaW5lZFNjaGVtYXMnO1xuaW1wb3J0IE9wdGlvbnNEZWZpbml0aW9ucyBmcm9tICcuL09wdGlvbnMvRGVmaW5pdGlvbnMnO1xuXG4vLyBNdXRhdGUgdGhlIFBhcnNlIG9iamVjdCB0byBhZGQgdGhlIENsb3VkIENvZGUgaGFuZGxlcnNcbmFkZFBhcnNlQ2xvdWQoKTtcblxuLy8gUGFyc2VTZXJ2ZXIgd29ya3MgbGlrZSBhIGNvbnN0cnVjdG9yIG9mIGFuIGV4cHJlc3MgYXBwLlxuLy8gaHR0cHM6Ly9wYXJzZXBsYXRmb3JtLm9yZy9wYXJzZS1zZXJ2ZXIvYXBpL21hc3Rlci9QYXJzZVNlcnZlck9wdGlvbnMuaHRtbFxuY2xhc3MgUGFyc2VTZXJ2ZXIge1xuICAvKipcbiAgICogQGNvbnN0cnVjdG9yXG4gICAqIEBwYXJhbSB7UGFyc2VTZXJ2ZXJPcHRpb25zfSBvcHRpb25zIHRoZSBwYXJzZSBzZXJ2ZXIgaW5pdGlhbGl6YXRpb24gb3B0aW9uc1xuICAgKi9cbiAgY29uc3RydWN0b3Iob3B0aW9uczogUGFyc2VTZXJ2ZXJPcHRpb25zKSB7XG4gICAgLy8gU2NhbiBmb3IgZGVwcmVjYXRlZCBQYXJzZSBTZXJ2ZXIgb3B0aW9uc1xuICAgIERlcHJlY2F0b3Iuc2NhblBhcnNlU2VydmVyT3B0aW9ucyhvcHRpb25zKTtcblxuICAgIGNvbnN0IGludGVyZmFjZXMgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KE9wdGlvbnNEZWZpbml0aW9ucykpO1xuXG4gICAgZnVuY3Rpb24gZ2V0VmFsaWRPYmplY3Qocm9vdCkge1xuICAgICAgY29uc3QgcmVzdWx0ID0ge307XG4gICAgICBmb3IgKGNvbnN0IGtleSBpbiByb290KSB7XG4gICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocm9vdFtrZXldLCAndHlwZScpKSB7XG4gICAgICAgICAgaWYgKHJvb3Rba2V5XS50eXBlLmVuZHNXaXRoKCdbXScpKSB7XG4gICAgICAgICAgICByZXN1bHRba2V5XSA9IFtnZXRWYWxpZE9iamVjdChpbnRlcmZhY2VzW3Jvb3Rba2V5XS50eXBlLnNsaWNlKDAsIC0yKV0pXTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmVzdWx0W2tleV0gPSBnZXRWYWxpZE9iamVjdChpbnRlcmZhY2VzW3Jvb3Rba2V5XS50eXBlXSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdFtrZXldID0gJyc7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgY29uc3Qgb3B0aW9uc0JsdWVwcmludCA9IGdldFZhbGlkT2JqZWN0KGludGVyZmFjZXNbJ1BhcnNlU2VydmVyT3B0aW9ucyddKTtcblxuICAgIGZ1bmN0aW9uIHZhbGlkYXRlS2V5TmFtZXMob3JpZ2luYWwsIHJlZiwgbmFtZSA9ICcnKSB7XG4gICAgICBsZXQgcmVzdWx0ID0gW107XG4gICAgICBjb25zdCBwcmVmaXggPSBuYW1lICsgKG5hbWUgIT09ICcnID8gJy4nIDogJycpO1xuICAgICAgZm9yIChjb25zdCBrZXkgaW4gb3JpZ2luYWwpIHtcbiAgICAgICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVmLCBrZXkpKSB7XG4gICAgICAgICAgcmVzdWx0LnB1c2gocHJlZml4ICsga2V5KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZiAocmVmW2tleV0gPT09ICcnKSB7IGNvbnRpbnVlOyB9XG4gICAgICAgICAgbGV0IHJlcyA9IFtdO1xuICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yaWdpbmFsW2tleV0pICYmIEFycmF5LmlzQXJyYXkocmVmW2tleV0pKSB7XG4gICAgICAgICAgICBjb25zdCB0eXBlID0gcmVmW2tleV1bMF07XG4gICAgICAgICAgICBvcmlnaW5hbFtrZXldLmZvckVhY2goKGl0ZW0sIGlkeCkgPT4ge1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIGl0ZW0gPT09ICdvYmplY3QnICYmIGl0ZW0gIT09IG51bGwpIHtcbiAgICAgICAgICAgICAgICByZXMgPSByZXMuY29uY2F0KHZhbGlkYXRlS2V5TmFtZXMoaXRlbSwgdHlwZSwgcHJlZml4ICsga2V5ICsgYFske2lkeH1dYCkpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBvcmlnaW5hbFtrZXldID09PSAnb2JqZWN0JyAmJiB0eXBlb2YgcmVmW2tleV0gPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICByZXMgPSB2YWxpZGF0ZUtleU5hbWVzKG9yaWdpbmFsW2tleV0sIHJlZltrZXldLCBwcmVmaXggKyBrZXkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXN1bHQgPSByZXN1bHQuY29uY2F0KHJlcyk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgY29uc3QgZGlmZiA9IHZhbGlkYXRlS2V5TmFtZXMob3B0aW9ucywgb3B0aW9uc0JsdWVwcmludCk7XG4gICAgaWYgKGRpZmYubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbG9nZ2VyID0gbG9nZ2luZy5sb2dnZXI7XG4gICAgICBsb2dnZXIuZXJyb3IoYEludmFsaWQga2V5KHMpIGZvdW5kIGluIFBhcnNlIFNlcnZlciBjb25maWd1cmF0aW9uOiAke2RpZmYuam9pbignLCAnKX1gKTtcbiAgICB9XG5cbiAgICAvLyBTZXQgb3B0aW9uIGRlZmF1bHRzXG4gICAgaW5qZWN0RGVmYXVsdHMob3B0aW9ucyk7XG4gICAgY29uc3Qge1xuICAgICAgYXBwSWQgPSByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhbiBhcHBJZCEnKSxcbiAgICAgIG1hc3RlcktleSA9IHJlcXVpcmVkUGFyYW1ldGVyKCdZb3UgbXVzdCBwcm92aWRlIGEgbWFzdGVyS2V5IScpLFxuICAgICAgamF2YXNjcmlwdEtleSxcbiAgICAgIHNlcnZlclVSTCA9IHJlcXVpcmVkUGFyYW1ldGVyKCdZb3UgbXVzdCBwcm92aWRlIGEgc2VydmVyVVJMIScpLFxuICAgIH0gPSBvcHRpb25zO1xuICAgIC8vIEluaXRpYWxpemUgdGhlIG5vZGUgY2xpZW50IFNESyBhdXRvbWF0aWNhbGx5XG4gICAgUGFyc2UuaW5pdGlhbGl6ZShhcHBJZCwgamF2YXNjcmlwdEtleSB8fCAndW51c2VkJywgbWFzdGVyS2V5KTtcbiAgICBQYXJzZS5zZXJ2ZXJVUkwgPSBzZXJ2ZXJVUkw7XG4gICAgQ29uZmlnLnZhbGlkYXRlT3B0aW9ucyhvcHRpb25zKTtcbiAgICBjb25zdCBhbGxDb250cm9sbGVycyA9IGNvbnRyb2xsZXJzLmdldENvbnRyb2xsZXJzKG9wdGlvbnMpO1xuXG4gICAgb3B0aW9ucy5zdGF0ZSA9ICdpbml0aWFsaXplZCc7XG4gICAgdGhpcy5jb25maWcgPSBDb25maWcucHV0KE9iamVjdC5hc3NpZ24oe30sIG9wdGlvbnMsIGFsbENvbnRyb2xsZXJzKSk7XG4gICAgdGhpcy5jb25maWcubWFzdGVyS2V5SXBzU3RvcmUgPSBuZXcgTWFwKCk7XG4gICAgdGhpcy5jb25maWcubWFpbnRlbmFuY2VLZXlJcHNTdG9yZSA9IG5ldyBNYXAoKTtcbiAgICBsb2dnaW5nLnNldExvZ2dlcihhbGxDb250cm9sbGVycy5sb2dnZXJDb250cm9sbGVyKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTdGFydHMgUGFyc2UgU2VydmVyIGFzIGFuIGV4cHJlc3MgYXBwOyB0aGlzIHByb21pc2UgcmVzb2x2ZXMgd2hlbiBQYXJzZSBTZXJ2ZXIgaXMgcmVhZHkgdG8gYWNjZXB0IHJlcXVlc3RzLlxuICAgKi9cblxuICBhc3luYyBzdGFydCgpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKHRoaXMuY29uZmlnLnN0YXRlID09PSAnb2snKSB7XG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgfVxuICAgICAgdGhpcy5jb25maWcuc3RhdGUgPSAnc3RhcnRpbmcnO1xuICAgICAgQ29uZmlnLnB1dCh0aGlzLmNvbmZpZyk7XG4gICAgICBjb25zdCB7XG4gICAgICAgIGRhdGFiYXNlQ29udHJvbGxlcixcbiAgICAgICAgaG9va3NDb250cm9sbGVyLFxuICAgICAgICBjYWNoZUNvbnRyb2xsZXIsXG4gICAgICAgIGNsb3VkLFxuICAgICAgICBzZWN1cml0eSxcbiAgICAgICAgc2NoZW1hLFxuICAgICAgICBsaXZlUXVlcnlDb250cm9sbGVyLFxuICAgICAgfSA9IHRoaXMuY29uZmlnO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZGF0YWJhc2VDb250cm9sbGVyLnBlcmZvcm1Jbml0aWFsaXphdGlvbigpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoZS5jb2RlICE9PSBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUpIHtcbiAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb25zdCBwdXNoQ29udHJvbGxlciA9IGF3YWl0IGNvbnRyb2xsZXJzLmdldFB1c2hDb250cm9sbGVyKHRoaXMuY29uZmlnKTtcbiAgICAgIGF3YWl0IGhvb2tzQ29udHJvbGxlci5sb2FkKCk7XG4gICAgICBjb25zdCBzdGFydHVwUHJvbWlzZXMgPSBbXTtcbiAgICAgIGlmIChzY2hlbWEpIHtcbiAgICAgICAgc3RhcnR1cFByb21pc2VzLnB1c2gobmV3IERlZmluZWRTY2hlbWFzKHNjaGVtYSwgdGhpcy5jb25maWcpLmV4ZWN1dGUoKSk7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgIGNhY2hlQ29udHJvbGxlci5hZGFwdGVyPy5jb25uZWN0ICYmXG4gICAgICAgIHR5cGVvZiBjYWNoZUNvbnRyb2xsZXIuYWRhcHRlci5jb25uZWN0ID09PSAnZnVuY3Rpb24nXG4gICAgICApIHtcbiAgICAgICAgc3RhcnR1cFByb21pc2VzLnB1c2goY2FjaGVDb250cm9sbGVyLmFkYXB0ZXIuY29ubmVjdCgpKTtcbiAgICAgIH1cbiAgICAgIHN0YXJ0dXBQcm9taXNlcy5wdXNoKGxpdmVRdWVyeUNvbnRyb2xsZXIuY29ubmVjdCgpKTtcbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKHN0YXJ0dXBQcm9taXNlcyk7XG4gICAgICBpZiAoY2xvdWQpIHtcbiAgICAgICAgYWRkUGFyc2VDbG91ZCgpO1xuICAgICAgICBpZiAodHlwZW9mIGNsb3VkID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKGNsb3VkKFBhcnNlKSk7XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGNsb3VkID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIGxldCBqc29uO1xuICAgICAgICAgIGlmIChwcm9jZXNzLmVudi5ucG1fcGFja2FnZV9qc29uKSB7XG4gICAgICAgICAgICBqc29uID0gcmVxdWlyZShwcm9jZXNzLmVudi5ucG1fcGFja2FnZV9qc29uKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHByb2Nlc3MuZW52Lm5wbV9wYWNrYWdlX3R5cGUgPT09ICdtb2R1bGUnIHx8IGpzb24/LnR5cGUgPT09ICdtb2R1bGUnKSB7XG4gICAgICAgICAgICBhd2FpdCBpbXBvcnQocGF0aC5yZXNvbHZlKHByb2Nlc3MuY3dkKCksIGNsb3VkKSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlcXVpcmUocGF0aC5yZXNvbHZlKHByb2Nlc3MuY3dkKCksIGNsb3VkKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IFwiYXJndW1lbnQgJ2Nsb3VkJyBtdXN0IGVpdGhlciBiZSBhIHN0cmluZyBvciBhIGZ1bmN0aW9uXCI7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwKSk7XG4gICAgICB9XG4gICAgICBpZiAoc2VjdXJpdHkgJiYgc2VjdXJpdHkuZW5hYmxlQ2hlY2sgJiYgc2VjdXJpdHkuZW5hYmxlQ2hlY2tMb2cpIHtcbiAgICAgICAgbmV3IENoZWNrUnVubmVyKHNlY3VyaXR5KS5ydW4oKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuY29uZmlnLnN0YXRlID0gJ29rJztcbiAgICAgIHRoaXMuY29uZmlnID0geyAuLi50aGlzLmNvbmZpZywgLi4ucHVzaENvbnRyb2xsZXIgfTtcbiAgICAgIENvbmZpZy5wdXQodGhpcy5jb25maWcpO1xuICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xuICAgICAgdGhpcy5jb25maWcuc3RhdGUgPSAnZXJyb3InO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgZ2V0IGFwcCgpIHtcbiAgICBpZiAoIXRoaXMuX2FwcCkge1xuICAgICAgdGhpcy5fYXBwID0gUGFyc2VTZXJ2ZXIuYXBwKHRoaXMuY29uZmlnKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuX2FwcDtcbiAgfVxuXG4gIGhhbmRsZVNodXRkb3duKCkge1xuICAgIGNvbnN0IHByb21pc2VzID0gW107XG4gICAgY29uc3QgeyBhZGFwdGVyOiBkYXRhYmFzZUFkYXB0ZXIgfSA9IHRoaXMuY29uZmlnLmRhdGFiYXNlQ29udHJvbGxlcjtcbiAgICBpZiAoZGF0YWJhc2VBZGFwdGVyICYmIHR5cGVvZiBkYXRhYmFzZUFkYXB0ZXIuaGFuZGxlU2h1dGRvd24gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHByb21pc2VzLnB1c2goZGF0YWJhc2VBZGFwdGVyLmhhbmRsZVNodXRkb3duKCkpO1xuICAgIH1cbiAgICBjb25zdCB7IGFkYXB0ZXI6IGZpbGVBZGFwdGVyIH0gPSB0aGlzLmNvbmZpZy5maWxlc0NvbnRyb2xsZXI7XG4gICAgaWYgKGZpbGVBZGFwdGVyICYmIHR5cGVvZiBmaWxlQWRhcHRlci5oYW5kbGVTaHV0ZG93biA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgcHJvbWlzZXMucHVzaChmaWxlQWRhcHRlci5oYW5kbGVTaHV0ZG93bigpKTtcbiAgICB9XG4gICAgY29uc3QgeyBhZGFwdGVyOiBjYWNoZUFkYXB0ZXIgfSA9IHRoaXMuY29uZmlnLmNhY2hlQ29udHJvbGxlcjtcbiAgICBpZiAoY2FjaGVBZGFwdGVyICYmIHR5cGVvZiBjYWNoZUFkYXB0ZXIuaGFuZGxlU2h1dGRvd24gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHByb21pc2VzLnB1c2goY2FjaGVBZGFwdGVyLmhhbmRsZVNodXRkb3duKCkpO1xuICAgIH1cbiAgICBpZiAodGhpcy5saXZlUXVlcnlTZXJ2ZXI/LnNlcnZlcj8uY2xvc2UpIHtcbiAgICAgIHByb21pc2VzLnB1c2gobmV3IFByb21pc2UocmVzb2x2ZSA9PiB0aGlzLmxpdmVRdWVyeVNlcnZlci5zZXJ2ZXIuY2xvc2UocmVzb2x2ZSkpKTtcbiAgICB9XG4gICAgaWYgKHRoaXMubGl2ZVF1ZXJ5U2VydmVyKSB7XG4gICAgICBwcm9taXNlcy5wdXNoKHRoaXMubGl2ZVF1ZXJ5U2VydmVyLnNodXRkb3duKCkpO1xuICAgIH1cbiAgICByZXR1cm4gKHByb21pc2VzLmxlbmd0aCA+IDAgPyBQcm9taXNlLmFsbChwcm9taXNlcykgOiBQcm9taXNlLnJlc29sdmUoKSkudGhlbigoKSA9PiB7XG4gICAgICBpZiAodGhpcy5jb25maWcuc2VydmVyQ2xvc2VDb21wbGV0ZSkge1xuICAgICAgICB0aGlzLmNvbmZpZy5zZXJ2ZXJDbG9zZUNvbXBsZXRlKCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogQHN0YXRpY1xuICAgKiBDcmVhdGUgYW4gZXhwcmVzcyBhcHAgZm9yIHRoZSBwYXJzZSBzZXJ2ZXJcbiAgICogQHBhcmFtIHtPYmplY3R9IG9wdGlvbnMgbGV0IHlvdSBzcGVjaWZ5IHRoZSBtYXhVcGxvYWRTaXplIHdoZW4gY3JlYXRpbmcgdGhlIGV4cHJlc3MgYXBwICAqL1xuICBzdGF0aWMgYXBwKG9wdGlvbnMpIHtcbiAgICBjb25zdCB7IG1heFVwbG9hZFNpemUgPSAnMjBtYicsIGFwcElkLCBkaXJlY3RBY2Nlc3MsIHBhZ2VzLCByYXRlTGltaXQgPSBbXSB9ID0gb3B0aW9ucztcbiAgICAvLyBUaGlzIGFwcCBzZXJ2ZXMgdGhlIFBhcnNlIEFQSSBkaXJlY3RseS5cbiAgICAvLyBJdCdzIHRoZSBlcXVpdmFsZW50IG9mIGh0dHBzOi8vYXBpLnBhcnNlLmNvbS8xIGluIHRoZSBob3N0ZWQgUGFyc2UgQVBJLlxuICAgIHZhciBhcGkgPSBleHByZXNzKCk7XG4gICAgLy9hcGkudXNlKFwiL2FwcHNcIiwgZXhwcmVzcy5zdGF0aWMoX19kaXJuYW1lICsgXCIvcHVibGljXCIpKTtcbiAgICBhcGkudXNlKG1pZGRsZXdhcmVzLmFsbG93Q3Jvc3NEb21haW4oYXBwSWQpKTtcbiAgICAvLyBGaWxlIGhhbmRsaW5nIG5lZWRzIHRvIGJlIGJlZm9yZSBkZWZhdWx0IG1pZGRsZXdhcmVzIGFyZSBhcHBsaWVkXG4gICAgYXBpLnVzZShcbiAgICAgICcvJyxcbiAgICAgIG5ldyBGaWxlc1JvdXRlcigpLmV4cHJlc3NSb3V0ZXIoe1xuICAgICAgICBtYXhVcGxvYWRTaXplOiBtYXhVcGxvYWRTaXplLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgYXBpLnVzZSgnL2hlYWx0aCcsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuICAgICAgcmVzLnN0YXR1cyhvcHRpb25zLnN0YXRlID09PSAnb2snID8gMjAwIDogNTAzKTtcbiAgICAgIGlmIChvcHRpb25zLnN0YXRlID09PSAnc3RhcnRpbmcnKSB7XG4gICAgICAgIHJlcy5zZXQoJ1JldHJ5LUFmdGVyJywgMSk7XG4gICAgICB9XG4gICAgICByZXMuanNvbih7XG4gICAgICAgIHN0YXR1czogb3B0aW9ucy5zdGF0ZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgYXBpLnVzZShcbiAgICAgICcvJyxcbiAgICAgIGJvZHlQYXJzZXIudXJsZW5jb2RlZCh7IGV4dGVuZGVkOiBmYWxzZSB9KSxcbiAgICAgIHBhZ2VzLmVuYWJsZVJvdXRlclxuICAgICAgICA/IG5ldyBQYWdlc1JvdXRlcihwYWdlcykuZXhwcmVzc1JvdXRlcigpXG4gICAgICAgIDogbmV3IFB1YmxpY0FQSVJvdXRlcigpLmV4cHJlc3NSb3V0ZXIoKVxuICAgICk7XG5cbiAgICBhcGkudXNlKGJvZHlQYXJzZXIuanNvbih7IHR5cGU6ICcqLyonLCBsaW1pdDogbWF4VXBsb2FkU2l6ZSB9KSk7XG4gICAgYXBpLnVzZShtaWRkbGV3YXJlcy5hbGxvd01ldGhvZE92ZXJyaWRlKTtcbiAgICBhcGkudXNlKG1pZGRsZXdhcmVzLmhhbmRsZVBhcnNlSGVhZGVycyk7XG4gICAgY29uc3Qgcm91dGVzID0gQXJyYXkuaXNBcnJheShyYXRlTGltaXQpID8gcmF0ZUxpbWl0IDogW3JhdGVMaW1pdF07XG4gICAgZm9yIChjb25zdCByb3V0ZSBvZiByb3V0ZXMpIHtcbiAgICAgIG1pZGRsZXdhcmVzLmFkZFJhdGVMaW1pdChyb3V0ZSwgb3B0aW9ucyk7XG4gICAgfVxuICAgIGFwaS51c2UobWlkZGxld2FyZXMuaGFuZGxlUGFyc2VTZXNzaW9uKTtcblxuICAgIGNvbnN0IGFwcFJvdXRlciA9IFBhcnNlU2VydmVyLnByb21pc2VSb3V0ZXIoeyBhcHBJZCB9KTtcbiAgICBhcGkudXNlKGFwcFJvdXRlci5leHByZXNzUm91dGVyKCkpO1xuXG4gICAgYXBpLnVzZShtaWRkbGV3YXJlcy5oYW5kbGVQYXJzZUVycm9ycyk7XG5cbiAgICAvLyBydW4gdGhlIGZvbGxvd2luZyB3aGVuIG5vdCB0ZXN0aW5nXG4gICAgaWYgKCFwcm9jZXNzLmVudi5URVNUSU5HKSB7XG4gICAgICAvL1RoaXMgY2F1c2VzIHRlc3RzIHRvIHNwZXcgc29tZSB1c2VsZXNzIHdhcm5pbmdzLCBzbyBkaXNhYmxlIGluIHRlc3RcbiAgICAgIC8qIGlzdGFuYnVsIGlnbm9yZSBuZXh0ICovXG4gICAgICBwcm9jZXNzLm9uKCd1bmNhdWdodEV4Y2VwdGlvbicsIGVyciA9PiB7XG4gICAgICAgIGlmIChlcnIuY29kZSA9PT0gJ0VBRERSSU5VU0UnKSB7XG4gICAgICAgICAgLy8gdXNlci1mcmllbmRseSBtZXNzYWdlIGZvciB0aGlzIGNvbW1vbiBlcnJvclxuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBVbmFibGUgdG8gbGlzdGVuIG9uIHBvcnQgJHtlcnIucG9ydH0uIFRoZSBwb3J0IGlzIGFscmVhZHkgaW4gdXNlLmApO1xuICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZiAoZXJyLm1lc3NhZ2UpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdBbiB1bmNhdWdodCBleGNlcHRpb24gb2NjdXJyZWQ6ICcgKyBlcnIubWVzc2FnZSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChlcnIuc3RhY2spIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdTdGFjayBUcmFjZTpcXG4nICsgZXJyLnN0YWNrKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIC8vIHZlcmlmeSB0aGUgc2VydmVyIHVybCBhZnRlciBhICdtb3VudCcgZXZlbnQgaXMgcmVjZWl2ZWRcbiAgICAgIC8qIGlzdGFuYnVsIGlnbm9yZSBuZXh0ICovXG4gICAgICBhcGkub24oJ21vdW50JywgYXN5bmMgZnVuY3Rpb24gKCkge1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMTAwMCkpO1xuICAgICAgICBQYXJzZVNlcnZlci52ZXJpZnlTZXJ2ZXJVcmwoKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAocHJvY2Vzcy5lbnYuUEFSU0VfU0VSVkVSX0VOQUJMRV9FWFBFUklNRU5UQUxfRElSRUNUX0FDQ0VTUyA9PT0gJzEnIHx8IGRpcmVjdEFjY2Vzcykge1xuICAgICAgUGFyc2UuQ29yZU1hbmFnZXIuc2V0UkVTVENvbnRyb2xsZXIoUGFyc2VTZXJ2ZXJSRVNUQ29udHJvbGxlcihhcHBJZCwgYXBwUm91dGVyKSk7XG4gICAgfVxuICAgIHJldHVybiBhcGk7XG4gIH1cblxuICBzdGF0aWMgcHJvbWlzZVJvdXRlcih7IGFwcElkIH0pIHtcbiAgICBjb25zdCByb3V0ZXJzID0gW1xuICAgICAgbmV3IENsYXNzZXNSb3V0ZXIoKSxcbiAgICAgIG5ldyBVc2Vyc1JvdXRlcigpLFxuICAgICAgbmV3IFNlc3Npb25zUm91dGVyKCksXG4gICAgICBuZXcgUm9sZXNSb3V0ZXIoKSxcbiAgICAgIG5ldyBBbmFseXRpY3NSb3V0ZXIoKSxcbiAgICAgIG5ldyBJbnN0YWxsYXRpb25zUm91dGVyKCksXG4gICAgICBuZXcgRnVuY3Rpb25zUm91dGVyKCksXG4gICAgICBuZXcgU2NoZW1hc1JvdXRlcigpLFxuICAgICAgbmV3IFB1c2hSb3V0ZXIoKSxcbiAgICAgIG5ldyBMb2dzUm91dGVyKCksXG4gICAgICBuZXcgSUFQVmFsaWRhdGlvblJvdXRlcigpLFxuICAgICAgbmV3IEZlYXR1cmVzUm91dGVyKCksXG4gICAgICBuZXcgR2xvYmFsQ29uZmlnUm91dGVyKCksXG4gICAgICBuZXcgR3JhcGhRTFJvdXRlcigpLFxuICAgICAgbmV3IFB1cmdlUm91dGVyKCksXG4gICAgICBuZXcgSG9va3NSb3V0ZXIoKSxcbiAgICAgIG5ldyBDbG91ZENvZGVSb3V0ZXIoKSxcbiAgICAgIG5ldyBBdWRpZW5jZXNSb3V0ZXIoKSxcbiAgICAgIG5ldyBBZ2dyZWdhdGVSb3V0ZXIoKSxcbiAgICAgIG5ldyBTZWN1cml0eVJvdXRlcigpLFxuICAgIF07XG5cbiAgICBjb25zdCByb3V0ZXMgPSByb3V0ZXJzLnJlZHVjZSgobWVtbywgcm91dGVyKSA9PiB7XG4gICAgICByZXR1cm4gbWVtby5jb25jYXQocm91dGVyLnJvdXRlcyk7XG4gICAgfSwgW10pO1xuXG4gICAgY29uc3QgYXBwUm91dGVyID0gbmV3IFByb21pc2VSb3V0ZXIocm91dGVzLCBhcHBJZCk7XG5cbiAgICBiYXRjaC5tb3VudE9udG8oYXBwUm91dGVyKTtcbiAgICByZXR1cm4gYXBwUm91dGVyO1xuICB9XG5cbiAgLyoqXG4gICAqIHN0YXJ0cyB0aGUgcGFyc2Ugc2VydmVyJ3MgZXhwcmVzcyBhcHBcbiAgICogQHBhcmFtIHtQYXJzZVNlcnZlck9wdGlvbnN9IG9wdGlvbnMgdG8gdXNlIHRvIHN0YXJ0IHRoZSBzZXJ2ZXJcbiAgICogQHJldHVybnMge1BhcnNlU2VydmVyfSB0aGUgcGFyc2Ugc2VydmVyIGluc3RhbmNlXG4gICAqL1xuXG4gIGFzeW5jIHN0YXJ0QXBwKG9wdGlvbnM6IFBhcnNlU2VydmVyT3B0aW9ucykge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLnN0YXJ0KCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcignRXJyb3Igb24gUGFyc2VTZXJ2ZXIuc3RhcnRBcHA6ICcsIGUpO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gICAgY29uc3QgYXBwID0gZXhwcmVzcygpO1xuICAgIGlmIChvcHRpb25zLm1pZGRsZXdhcmUpIHtcbiAgICAgIGxldCBtaWRkbGV3YXJlO1xuICAgICAgaWYgKHR5cGVvZiBvcHRpb25zLm1pZGRsZXdhcmUgPT0gJ3N0cmluZycpIHtcbiAgICAgICAgbWlkZGxld2FyZSA9IHJlcXVpcmUocGF0aC5yZXNvbHZlKHByb2Nlc3MuY3dkKCksIG9wdGlvbnMubWlkZGxld2FyZSkpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbWlkZGxld2FyZSA9IG9wdGlvbnMubWlkZGxld2FyZTsgLy8gdXNlIGFzLWlzIGxldCBleHByZXNzIGZhaWxcbiAgICAgIH1cbiAgICAgIGFwcC51c2UobWlkZGxld2FyZSk7XG4gICAgfVxuICAgIGFwcC51c2Uob3B0aW9ucy5tb3VudFBhdGgsIHRoaXMuYXBwKTtcblxuICAgIGlmIChvcHRpb25zLm1vdW50R3JhcGhRTCA9PT0gdHJ1ZSB8fCBvcHRpb25zLm1vdW50UGxheWdyb3VuZCA9PT0gdHJ1ZSkge1xuICAgICAgbGV0IGdyYXBoUUxDdXN0b21UeXBlRGVmcyA9IHVuZGVmaW5lZDtcbiAgICAgIGlmICh0eXBlb2Ygb3B0aW9ucy5ncmFwaFFMU2NoZW1hID09PSAnc3RyaW5nJykge1xuICAgICAgICBncmFwaFFMQ3VzdG9tVHlwZURlZnMgPSBwYXJzZShmcy5yZWFkRmlsZVN5bmMob3B0aW9ucy5ncmFwaFFMU2NoZW1hLCAndXRmOCcpKTtcbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIHR5cGVvZiBvcHRpb25zLmdyYXBoUUxTY2hlbWEgPT09ICdvYmplY3QnIHx8XG4gICAgICAgIHR5cGVvZiBvcHRpb25zLmdyYXBoUUxTY2hlbWEgPT09ICdmdW5jdGlvbidcbiAgICAgICkge1xuICAgICAgICBncmFwaFFMQ3VzdG9tVHlwZURlZnMgPSBvcHRpb25zLmdyYXBoUUxTY2hlbWE7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHBhcnNlR3JhcGhRTFNlcnZlciA9IG5ldyBQYXJzZUdyYXBoUUxTZXJ2ZXIodGhpcywge1xuICAgICAgICBncmFwaFFMUGF0aDogb3B0aW9ucy5ncmFwaFFMUGF0aCxcbiAgICAgICAgcGxheWdyb3VuZFBhdGg6IG9wdGlvbnMucGxheWdyb3VuZFBhdGgsXG4gICAgICAgIGdyYXBoUUxDdXN0b21UeXBlRGVmcyxcbiAgICAgIH0pO1xuXG4gICAgICBpZiAob3B0aW9ucy5tb3VudEdyYXBoUUwpIHtcbiAgICAgICAgcGFyc2VHcmFwaFFMU2VydmVyLmFwcGx5R3JhcGhRTChhcHApO1xuICAgICAgfVxuXG4gICAgICBpZiAob3B0aW9ucy5tb3VudFBsYXlncm91bmQpIHtcbiAgICAgICAgcGFyc2VHcmFwaFFMU2VydmVyLmFwcGx5UGxheWdyb3VuZChhcHApO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBzZXJ2ZXIgPSBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIGFwcC5saXN0ZW4ob3B0aW9ucy5wb3J0LCBvcHRpb25zLmhvc3QsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmVzb2x2ZSh0aGlzKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMuc2VydmVyID0gc2VydmVyO1xuXG4gICAgaWYgKG9wdGlvbnMuc3RhcnRMaXZlUXVlcnlTZXJ2ZXIgfHwgb3B0aW9ucy5saXZlUXVlcnlTZXJ2ZXJPcHRpb25zKSB7XG4gICAgICB0aGlzLmxpdmVRdWVyeVNlcnZlciA9IGF3YWl0IFBhcnNlU2VydmVyLmNyZWF0ZUxpdmVRdWVyeVNlcnZlcihcbiAgICAgICAgc2VydmVyLFxuICAgICAgICBvcHRpb25zLmxpdmVRdWVyeVNlcnZlck9wdGlvbnMsXG4gICAgICAgIG9wdGlvbnNcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvcHRpb25zLnRydXN0UHJveHkpIHtcbiAgICAgIGFwcC5zZXQoJ3RydXN0IHByb3h5Jywgb3B0aW9ucy50cnVzdFByb3h5KTtcbiAgICB9XG4gICAgLyogaXN0YW5idWwgaWdub3JlIG5leHQgKi9cbiAgICBpZiAoIXByb2Nlc3MuZW52LlRFU1RJTkcpIHtcbiAgICAgIGNvbmZpZ3VyZUxpc3RlbmVycyh0aGlzKTtcbiAgICB9XG4gICAgdGhpcy5leHByZXNzQXBwID0gYXBwO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZXMgYSBuZXcgUGFyc2VTZXJ2ZXIgYW5kIHN0YXJ0cyBpdC5cbiAgICogQHBhcmFtIHtQYXJzZVNlcnZlck9wdGlvbnN9IG9wdGlvbnMgdXNlZCB0byBzdGFydCB0aGUgc2VydmVyXG4gICAqIEByZXR1cm5zIHtQYXJzZVNlcnZlcn0gdGhlIHBhcnNlIHNlcnZlciBpbnN0YW5jZVxuICAgKi9cbiAgc3RhdGljIGFzeW5jIHN0YXJ0QXBwKG9wdGlvbnM6IFBhcnNlU2VydmVyT3B0aW9ucykge1xuICAgIGNvbnN0IHBhcnNlU2VydmVyID0gbmV3IFBhcnNlU2VydmVyKG9wdGlvbnMpO1xuICAgIHJldHVybiBwYXJzZVNlcnZlci5zdGFydEFwcChvcHRpb25zKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBIZWxwZXIgbWV0aG9kIHRvIGNyZWF0ZSBhIGxpdmVRdWVyeSBzZXJ2ZXJcbiAgICogQHN0YXRpY1xuICAgKiBAcGFyYW0ge1NlcnZlcn0gaHR0cFNlcnZlciBhbiBvcHRpb25hbCBodHRwIHNlcnZlciB0byBwYXNzXG4gICAqIEBwYXJhbSB7TGl2ZVF1ZXJ5U2VydmVyT3B0aW9uc30gY29uZmlnIG9wdGlvbnMgZm9yIHRoZSBsaXZlUXVlcnlTZXJ2ZXJcbiAgICogQHBhcmFtIHtQYXJzZVNlcnZlck9wdGlvbnN9IG9wdGlvbnMgb3B0aW9ucyBmb3IgdGhlIFBhcnNlU2VydmVyXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPFBhcnNlTGl2ZVF1ZXJ5U2VydmVyPn0gdGhlIGxpdmUgcXVlcnkgc2VydmVyIGluc3RhbmNlXG4gICAqL1xuICBzdGF0aWMgYXN5bmMgY3JlYXRlTGl2ZVF1ZXJ5U2VydmVyKFxuICAgIGh0dHBTZXJ2ZXIsXG4gICAgY29uZmlnOiBMaXZlUXVlcnlTZXJ2ZXJPcHRpb25zLFxuICAgIG9wdGlvbnM6IFBhcnNlU2VydmVyT3B0aW9uc1xuICApIHtcbiAgICBpZiAoIWh0dHBTZXJ2ZXIgfHwgKGNvbmZpZyAmJiBjb25maWcucG9ydCkpIHtcbiAgICAgIHZhciBhcHAgPSBleHByZXNzKCk7XG4gICAgICBodHRwU2VydmVyID0gcmVxdWlyZSgnaHR0cCcpLmNyZWF0ZVNlcnZlcihhcHApO1xuICAgICAgaHR0cFNlcnZlci5saXN0ZW4oY29uZmlnLnBvcnQpO1xuICAgIH1cbiAgICBjb25zdCBzZXJ2ZXIgPSBuZXcgUGFyc2VMaXZlUXVlcnlTZXJ2ZXIoaHR0cFNlcnZlciwgY29uZmlnLCBvcHRpb25zKTtcbiAgICBhd2FpdCBzZXJ2ZXIuY29ubmVjdCgpO1xuICAgIHJldHVybiBzZXJ2ZXI7XG4gIH1cblxuICBzdGF0aWMgYXN5bmMgdmVyaWZ5U2VydmVyVXJsKCkge1xuICAgIC8vIHBlcmZvcm0gYSBoZWFsdGggY2hlY2sgb24gdGhlIHNlcnZlclVSTCB2YWx1ZVxuICAgIGlmIChQYXJzZS5zZXJ2ZXJVUkwpIHtcbiAgICAgIGNvbnN0IGlzVmFsaWRIdHRwVXJsID0gc3RyaW5nID0+IHtcbiAgICAgICAgbGV0IHVybDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB1cmwgPSBuZXcgVVJMKHN0cmluZyk7XG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHVybC5wcm90b2NvbCA9PT0gJ2h0dHA6JyB8fCB1cmwucHJvdG9jb2wgPT09ICdodHRwczonO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHVybCA9IGAke1BhcnNlLnNlcnZlclVSTC5yZXBsYWNlKC9cXC8kLywgJycpfS9oZWFsdGhgO1xuICAgICAgaWYgKCFpc1ZhbGlkSHR0cFVybCh1cmwpKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICBgXFxuV0FSTklORywgVW5hYmxlIHRvIGNvbm5lY3QgdG8gJyR7UGFyc2Uuc2VydmVyVVJMfScgYXMgdGhlIFVSTCBpcyBpbnZhbGlkLmAgK1xuICAgICAgICAgICAgYCBDbG91ZCBjb2RlIGFuZCBwdXNoIG5vdGlmaWNhdGlvbnMgbWF5IGJlIHVuYXZhaWxhYmxlIVxcbmBcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVxdWVzdCA9IHJlcXVpcmUoJy4vcmVxdWVzdCcpO1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0KHsgdXJsIH0pLmNhdGNoKHJlc3BvbnNlID0+IHJlc3BvbnNlKTtcbiAgICAgIGNvbnN0IGpzb24gPSByZXNwb25zZS5kYXRhIHx8IG51bGw7XG4gICAgICBjb25zdCByZXRyeSA9IHJlc3BvbnNlLmhlYWRlcnM/LlsncmV0cnktYWZ0ZXInXTtcbiAgICAgIGlmIChyZXRyeSkge1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgcmV0cnkgKiAxMDAwKSk7XG4gICAgICAgIHJldHVybiB0aGlzLnZlcmlmeVNlcnZlclVybCgpO1xuICAgICAgfVxuICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1cyAhPT0gMjAwIHx8IGpzb24/LnN0YXR1cyAhPT0gJ29rJykge1xuICAgICAgICAvKiBlc2xpbnQtZGlzYWJsZSBuby1jb25zb2xlICovXG4gICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICBgXFxuV0FSTklORywgVW5hYmxlIHRvIGNvbm5lY3QgdG8gJyR7UGFyc2Uuc2VydmVyVVJMfScuYCArXG4gICAgICAgICAgICBgIENsb3VkIGNvZGUgYW5kIHB1c2ggbm90aWZpY2F0aW9ucyBtYXkgYmUgdW5hdmFpbGFibGUhXFxuYFxuICAgICAgICApO1xuICAgICAgICAvKiBlc2xpbnQtZW5hYmxlIG5vLWNvbnNvbGUgKi9cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGFkZFBhcnNlQ2xvdWQoKSB7XG4gIGNvbnN0IFBhcnNlQ2xvdWQgPSByZXF1aXJlKCcuL2Nsb3VkLWNvZGUvUGFyc2UuQ2xvdWQnKTtcbiAgY29uc3QgUGFyc2VTZXJ2ZXIgPSByZXF1aXJlKCcuL2Nsb3VkLWNvZGUvUGFyc2UuU2VydmVyJyk7XG4gIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShQYXJzZSwgJ1NlcnZlcicsIHtcbiAgICBnZXQoKSB7XG4gICAgICBjb25zdCBjb25mID0gQ29uZmlnLmdldChQYXJzZS5hcHBsaWNhdGlvbklkKTtcbiAgICAgIHJldHVybiB7IC4uLmNvbmYsIC4uLlBhcnNlU2VydmVyIH07XG4gICAgfSxcbiAgICBzZXQobmV3VmFsKSB7XG4gICAgICBuZXdWYWwuYXBwSWQgPSBQYXJzZS5hcHBsaWNhdGlvbklkO1xuICAgICAgQ29uZmlnLnB1dChuZXdWYWwpO1xuICAgIH0sXG4gICAgY29uZmlndXJhYmxlOiB0cnVlLFxuICB9KTtcbiAgT2JqZWN0LmFzc2lnbihQYXJzZS5DbG91ZCwgUGFyc2VDbG91ZCk7XG4gIGdsb2JhbC5QYXJzZSA9IFBhcnNlO1xufVxuXG5mdW5jdGlvbiBpbmplY3REZWZhdWx0cyhvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnMpIHtcbiAgT2JqZWN0LmtleXMoZGVmYXVsdHMpLmZvckVhY2goa2V5ID0+IHtcbiAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvcHRpb25zLCBrZXkpKSB7XG4gICAgICBvcHRpb25zW2tleV0gPSBkZWZhdWx0c1trZXldO1xuICAgIH1cbiAgfSk7XG5cbiAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob3B0aW9ucywgJ3NlcnZlclVSTCcpKSB7XG4gICAgb3B0aW9ucy5zZXJ2ZXJVUkwgPSBgaHR0cDovL2xvY2FsaG9zdDoke29wdGlvbnMucG9ydH0ke29wdGlvbnMubW91bnRQYXRofWA7XG4gIH1cblxuICAvLyBSZXNlcnZlZCBDaGFyYWN0ZXJzXG4gIGlmIChvcHRpb25zLmFwcElkKSB7XG4gICAgY29uc3QgcmVnZXggPSAvWyEjJCUnKCkqKyYvOjs9P0BbXFxde31eLHw8Pl0vZztcbiAgICBpZiAob3B0aW9ucy5hcHBJZC5tYXRjaChyZWdleCkpIHtcbiAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgYFxcbldBUk5JTkcsIGFwcElkIHRoYXQgY29udGFpbnMgc3BlY2lhbCBjaGFyYWN0ZXJzIGNhbiBjYXVzZSBpc3N1ZXMgd2hpbGUgdXNpbmcgd2l0aCB1cmxzLlxcbmBcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gQmFja3dhcmRzIGNvbXBhdGliaWxpdHlcbiAgaWYgKG9wdGlvbnMudXNlclNlbnNpdGl2ZUZpZWxkcykge1xuICAgIC8qIGVzbGludC1kaXNhYmxlIG5vLWNvbnNvbGUgKi9cbiAgICAhcHJvY2Vzcy5lbnYuVEVTVElORyAmJlxuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgXFxuREVQUkVDQVRFRDogdXNlclNlbnNpdGl2ZUZpZWxkcyBoYXMgYmVlbiByZXBsYWNlZCBieSBwcm90ZWN0ZWRGaWVsZHMgYWxsb3dpbmcgdGhlIGFiaWxpdHkgdG8gcHJvdGVjdCBmaWVsZHMgaW4gYWxsIGNsYXNzZXMgd2l0aCBDTFAuIFxcbmBcbiAgICAgICk7XG4gICAgLyogZXNsaW50LWVuYWJsZSBuby1jb25zb2xlICovXG5cbiAgICBjb25zdCB1c2VyU2Vuc2l0aXZlRmllbGRzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoWy4uLihkZWZhdWx0cy51c2VyU2Vuc2l0aXZlRmllbGRzIHx8IFtdKSwgLi4uKG9wdGlvbnMudXNlclNlbnNpdGl2ZUZpZWxkcyB8fCBbXSldKVxuICAgICk7XG5cbiAgICAvLyBJZiB0aGUgb3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHMgaXMgdW5zZXQsXG4gICAgLy8gaXQnbGwgYmUgYXNzaWduZWQgdGhlIGRlZmF1bHQgYWJvdmUuXG4gICAgLy8gSGVyZSwgcHJvdGVjdCBhZ2FpbnN0IHRoZSBjYXNlIHdoZXJlIHByb3RlY3RlZEZpZWxkc1xuICAgIC8vIGlzIHNldCwgYnV0IGRvZXNuJ3QgaGF2ZSBfVXNlci5cbiAgICBpZiAoISgnX1VzZXInIGluIG9wdGlvbnMucHJvdGVjdGVkRmllbGRzKSkge1xuICAgICAgb3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHMgPSBPYmplY3QuYXNzaWduKHsgX1VzZXI6IFtdIH0sIG9wdGlvbnMucHJvdGVjdGVkRmllbGRzKTtcbiAgICB9XG5cbiAgICBvcHRpb25zLnByb3RlY3RlZEZpZWxkc1snX1VzZXInXVsnKiddID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoWy4uLihvcHRpb25zLnByb3RlY3RlZEZpZWxkc1snX1VzZXInXVsnKiddIHx8IFtdKSwgLi4udXNlclNlbnNpdGl2ZUZpZWxkc10pXG4gICAgKTtcbiAgfVxuXG4gIC8vIE1lcmdlIHByb3RlY3RlZEZpZWxkcyBvcHRpb25zIHdpdGggZGVmYXVsdHMuXG4gIE9iamVjdC5rZXlzKGRlZmF1bHRzLnByb3RlY3RlZEZpZWxkcykuZm9yRWFjaChjID0+IHtcbiAgICBjb25zdCBjdXIgPSBvcHRpb25zLnByb3RlY3RlZEZpZWxkc1tjXTtcbiAgICBpZiAoIWN1cikge1xuICAgICAgb3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHNbY10gPSBkZWZhdWx0cy5wcm90ZWN0ZWRGaWVsZHNbY107XG4gICAgfSBlbHNlIHtcbiAgICAgIE9iamVjdC5rZXlzKGRlZmF1bHRzLnByb3RlY3RlZEZpZWxkc1tjXSkuZm9yRWFjaChyID0+IHtcbiAgICAgICAgY29uc3QgdW5xID0gbmV3IFNldChbXG4gICAgICAgICAgLi4uKG9wdGlvbnMucHJvdGVjdGVkRmllbGRzW2NdW3JdIHx8IFtdKSxcbiAgICAgICAgICAuLi5kZWZhdWx0cy5wcm90ZWN0ZWRGaWVsZHNbY11bcl0sXG4gICAgICAgIF0pO1xuICAgICAgICBvcHRpb25zLnByb3RlY3RlZEZpZWxkc1tjXVtyXSA9IEFycmF5LmZyb20odW5xKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfSk7XG59XG5cbi8vIFRob3NlIGNhbid0IGJlIHRlc3RlZCBhcyBpdCByZXF1aXJlcyBhIHN1YnByb2Nlc3Ncbi8qIGlzdGFuYnVsIGlnbm9yZSBuZXh0ICovXG5mdW5jdGlvbiBjb25maWd1cmVMaXN0ZW5lcnMocGFyc2VTZXJ2ZXIpIHtcbiAgY29uc3Qgc2VydmVyID0gcGFyc2VTZXJ2ZXIuc2VydmVyO1xuICBjb25zdCBzb2NrZXRzID0ge307XG4gIC8qIEN1cnJlbnRseSwgZXhwcmVzcyBkb2Vzbid0IHNodXQgZG93biBpbW1lZGlhdGVseSBhZnRlciByZWNlaXZpbmcgU0lHSU5UL1NJR1RFUk0gaWYgaXQgaGFzIGNsaWVudCBjb25uZWN0aW9ucyB0aGF0IGhhdmVuJ3QgdGltZWQgb3V0LiAoVGhpcyBpcyBhIGtub3duIGlzc3VlIHdpdGggbm9kZSAtIGh0dHBzOi8vZ2l0aHViLmNvbS9ub2RlanMvbm9kZS9pc3N1ZXMvMjY0MilcbiAgICBUaGlzIGZ1bmN0aW9uLCBhbG9uZyB3aXRoIGBkZXN0cm95QWxpdmVDb25uZWN0aW9ucygpYCwgaW50ZW5kIHRvIGZpeCB0aGlzIGJlaGF2aW9yIHN1Y2ggdGhhdCBwYXJzZSBzZXJ2ZXIgd2lsbCBjbG9zZSBhbGwgb3BlbiBjb25uZWN0aW9ucyBhbmQgaW5pdGlhdGUgdGhlIHNodXRkb3duIHByb2Nlc3MgYXMgc29vbiBhcyBpdCByZWNlaXZlcyBhIFNJR0lOVC9TSUdURVJNIHNpZ25hbC4gKi9cbiAgc2VydmVyLm9uKCdjb25uZWN0aW9uJywgc29ja2V0ID0+IHtcbiAgICBjb25zdCBzb2NrZXRJZCA9IHNvY2tldC5yZW1vdGVBZGRyZXNzICsgJzonICsgc29ja2V0LnJlbW90ZVBvcnQ7XG4gICAgc29ja2V0c1tzb2NrZXRJZF0gPSBzb2NrZXQ7XG4gICAgc29ja2V0Lm9uKCdjbG9zZScsICgpID0+IHtcbiAgICAgIGRlbGV0ZSBzb2NrZXRzW3NvY2tldElkXTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgY29uc3QgZGVzdHJveUFsaXZlQ29ubmVjdGlvbnMgPSBmdW5jdGlvbiAoKSB7XG4gICAgZm9yIChjb25zdCBzb2NrZXRJZCBpbiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBzb2NrZXRzW3NvY2tldElkXS5kZXN0cm95KCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8qICovXG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZVNodXRkb3duID0gZnVuY3Rpb24gKCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCdUZXJtaW5hdGlvbiBzaWduYWwgcmVjZWl2ZWQuIFNodXR0aW5nIGRvd24uJyk7XG4gICAgZGVzdHJveUFsaXZlQ29ubmVjdGlvbnMoKTtcbiAgICBzZXJ2ZXIuY2xvc2UoKTtcbiAgICBwYXJzZVNlcnZlci5oYW5kbGVTaHV0ZG93bigpO1xuICB9O1xuICBwcm9jZXNzLm9uKCdTSUdURVJNJywgaGFuZGxlU2h1dGRvd24pO1xuICBwcm9jZXNzLm9uKCdTSUdJTlQnLCBoYW5kbGVTaHV0ZG93bik7XG59XG5cbmV4cG9ydCBkZWZhdWx0IFBhcnNlU2VydmVyO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFXQSxJQUFBQSxRQUFBLEdBQUFDLE9BQUE7QUFDQSxJQUFBQyxTQUFBLEdBQUFDLHNCQUFBLENBQUFGLE9BQUE7QUFDQSxJQUFBRyxPQUFBLEdBQUFDLHVCQUFBLENBQUFKLE9BQUE7QUFDQSxJQUFBSyxPQUFBLEdBQUFILHNCQUFBLENBQUFGLE9BQUE7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
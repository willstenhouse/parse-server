"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.ClassesRouter = void 0;

var _PromiseRouter = _interopRequireDefault(require("../PromiseRouter"));

var _rest = _interopRequireDefault(require("../rest"));

var _lodash = _interopRequireDefault(require("lodash"));

var _node = _interopRequireDefault(require("parse/node"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const ALLOWED_GET_QUERY_KEYS = ['keys', 'include', 'excludeKeys', 'readPreference', 'includeReadPreference', 'subqueryReadPreference'];

class ClassesRouter extends _PromiseRouter.default {
  className(req) {
    return req.params.className;
  }

  handleFind(req) {
    const body = Object.assign(req.body, ClassesRouter.JSONFromQuery(req.query));
    const options = ClassesRouter.optionsFromBody(body);

    if (req.config.maxLimit && body.limit > req.config.maxLimit) {
      // Silently replace the limit on the query with the max configured
      options.limit = Number(req.config.maxLimit);
    }

    if (body.redirectClassNameForKey) {
      options.redirectClassNameForKey = String(body.redirectClassNameForKey);
    }

    if (typeof body.where === 'string') {
      body.where = JSON.parse(body.where);
    }

    return _rest.default.find(req.config, req.auth, this.className(req), body.where, options, req.info.clientSDK).then(response => {
      return {
        response: response
      };
    });
  } // Returns a promise for a {response} object.


  handleGet(req) {
    const body = Object.assign(req.body, ClassesRouter.JSONFromQuery(req.query));
    const options = {};

    for (const key of Object.keys(body)) {
      if (ALLOWED_GET_QUERY_KEYS.indexOf(key) === -1) {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, 'Improper encode of parameter');
      }
    }

    if (typeof body.keys === 'string') {
      options.keys = body.keys;
    }

    if (body.include) {
      options.include = String(body.include);
    }

    if (typeof body.excludeKeys == 'string') {
      options.excludeKeys = body.excludeKeys;
    }

    if (typeof body.readPreference === 'string') {
      options.readPreference = body.readPreference;
    }

    if (typeof body.includeReadPreference === 'string') {
      options.includeReadPreference = body.includeReadPreference;
    }

    if (typeof body.subqueryReadPreference === 'string') {
      options.subqueryReadPreference = body.subqueryReadPreference;
    }

    return _rest.default.get(req.config, req.auth, this.className(req), req.params.objectId, options, req.info.clientSDK).then(response => {
      if (!response.results || response.results.length == 0) {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }

      if (this.className(req) === '_User') {
        delete response.results[0].sessionToken;
        const user = response.results[0];

        if (req.auth.user && user.objectId == req.auth.user.id) {
          // Force the session token
          response.results[0].sessionToken = req.info.sessionToken;
        }
      }

      return {
        response: response.results[0]
      };
    });
  }

  handleCreate(req) {
    return _rest.default.create(req.config, req.auth, this.className(req), req.body, req.info.clientSDK);
  }

  handleUpdate(req) {
    const where = {
      objectId: req.params.objectId
    };
    return _rest.default.update(req.config, req.auth, this.className(req), where, req.body, req.info.clientSDK);
  }

  handleDelete(req) {
    return _rest.default.del(req.config, req.auth, this.className(req), req.params.objectId, req.info.clientSDK).then(() => {
      return {
        response: {}
      };
    });
  }

  static JSONFromQuery(query) {
    const json = {};

    for (const [key, value] of _lodash.default.entries(query)) {
      try {
        json[key] = JSON.parse(value);
      } catch (e) {
        json[key] = value;
      }
    }

    return json;
  }

  static optionsFromBody(body) {
    const allowConstraints = ['skip', 'limit', 'order', 'count', 'keys', 'excludeKeys', 'include', 'includeAll', 'redirectClassNameForKey', 'where', 'readPreference', 'includeReadPreference', 'subqueryReadPreference', 'hint', 'explain'];

    for (const key of Object.keys(body)) {
      if (allowConstraints.indexOf(key) === -1) {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Invalid parameter for query: ${key}`);
      }
    }

    const options = {};

    if (body.skip) {
      options.skip = Number(body.skip);
    }

    if (body.limit || body.limit === 0) {
      options.limit = Number(body.limit);
    } else {
      options.limit = Number(100);
    }

    if (body.order) {
      options.order = String(body.order);
    }

    if (body.count) {
      options.count = true;
    }

    if (typeof body.keys == 'string') {
      options.keys = body.keys;
    }

    if (typeof body.excludeKeys == 'string') {
      options.excludeKeys = body.excludeKeys;
    }

    if (body.include) {
      options.include = String(body.include);
    }

    if (body.includeAll) {
      options.includeAll = true;
    }

    if (typeof body.readPreference === 'string') {
      options.readPreference = body.readPreference;
    }

    if (typeof body.includeReadPreference === 'string') {
      options.includeReadPreference = body.includeReadPreference;
    }

    if (typeof body.subqueryReadPreference === 'string') {
      options.subqueryReadPreference = body.subqueryReadPreference;
    }

    if (body.hint && (typeof body.hint === 'string' || typeof body.hint === 'object')) {
      options.hint = body.hint;
    }

    if (body.explain) {
      options.explain = body.explain;
    }

    return options;
  }

  mountRoutes() {
    this.route('GET', '/classes/:className', req => {
      return this.handleFind(req);
    });
    this.route('GET', '/classes/:className/:objectId', req => {
      return this.handleGet(req);
    });
    this.route('POST', '/classes/:className', req => {
      return this.handleCreate(req);
    });
    this.route('PUT', '/classes/:className/:objectId', req => {
      return this.handleUpdate(req);
    });
    this.route('DELETE', '/classes/:className/:objectId', req => {
      return this.handleDelete(req);
    });
  }

}

exports.ClassesRouter = ClassesRouter;
var _default = ClassesRouter;
exports.default = _default;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Sb3V0ZXJzL0NsYXNzZXNSb3V0ZXIuanMiXSwibmFtZXMiOlsiQUxMT1dFRF9HRVRfUVVFUllfS0VZUyIsIkNsYXNzZXNSb3V0ZXIiLCJQcm9taXNlUm91dGVyIiwiY2xhc3NOYW1lIiwicmVxIiwicGFyYW1zIiwiaGFuZGxlRmluZCIsImJvZHkiLCJPYmplY3QiLCJhc3NpZ24iLCJKU09ORnJvbVF1ZXJ5IiwicXVlcnkiLCJvcHRpb25zIiwib3B0aW9uc0Zyb21Cb2R5IiwiY29uZmlnIiwibWF4TGltaXQiLCJsaW1pdCIsIk51bWJlciIsInJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IiwiU3RyaW5nIiwid2hlcmUiLCJKU09OIiwicGFyc2UiLCJyZXN0IiwiZmluZCIsImF1dGgiLCJpbmZvIiwiY2xpZW50U0RLIiwidGhlbiIsInJlc3BvbnNlIiwiaGFuZGxlR2V0Iiwia2V5Iiwia2V5cyIsImluZGV4T2YiLCJQYXJzZSIsIkVycm9yIiwiSU5WQUxJRF9RVUVSWSIsImluY2x1ZGUiLCJleGNsdWRlS2V5cyIsInJlYWRQcmVmZXJlbmNlIiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsImdldCIsIm9iamVjdElkIiwicmVzdWx0cyIsImxlbmd0aCIsIk9CSkVDVF9OT1RfRk9VTkQiLCJzZXNzaW9uVG9rZW4iLCJ1c2VyIiwiaWQiLCJoYW5kbGVDcmVhdGUiLCJjcmVhdGUiLCJoYW5kbGVVcGRhdGUiLCJ1cGRhdGUiLCJoYW5kbGVEZWxldGUiLCJkZWwiLCJqc29uIiwidmFsdWUiLCJfIiwiZW50cmllcyIsImUiLCJhbGxvd0NvbnN0cmFpbnRzIiwic2tpcCIsIm9yZGVyIiwiY291bnQiLCJpbmNsdWRlQWxsIiwiaGludCIsImV4cGxhaW4iLCJtb3VudFJvdXRlcyIsInJvdXRlIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7O0FBQ0E7O0FBQ0E7O0FBQ0E7Ozs7QUFFQSxNQUFNQSxzQkFBc0IsR0FB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LE9BQXZCO0FBQ0Q7O0FBQ0QsV0FBT3ZELE9BQVA7QUFDRDs7QUFFRHdELEVBQUFBLFdBQVcsR0FBRztBQUNaLFNBQUtDLEtBQUwsQ0FBVyxLQUFYLEVBQWtCLHFCQUFsQixFQUF5Q2pFLEdBQUcsSUFBSTtBQUM5QyxhQUFPLEtBQUtFLFVBQUwsQ0FBZ0JGLEdBQWhCLENBQVA7QUFDRCxLQUZEO0FBR0EsU0FBS2lFLEtBQUwsQ0FBVyxLQUFYLEVBQWtCLCtCQUFsQixFQUFtRGpFLEdBQUcsSUFBSTtBQUN4RCxhQUFPLEtBQUswQixTQUFMLENBQWUxQixHQUFmLENBQVA7QUFDRCxLQUZEO0FBR0EsU0FBS2lFLEtBQUwsQ0FBVyxNQUFYLEVBQW1CLHFCQUFuQixFQUEwQ2pFLEdBQUcsSUFBSTtBQUMvQyxhQUFPLEtBQUs4QyxZQUFMLENBQWtCOUMsR0FBbEIsQ0FBUDtBQUNELEtBRkQ7QUFHQSxTQUFLaUUsS0FBTCxDQUFXLEtBQVgsRUFBa0IsK0JBQWxCLEVBQW1EakUsR0FBRyxJQUFJO0FBQ3hELGFBQU8sS0FBS2dELFlBQUwsQ0FBa0JoRCxHQUFsQixDQUFQO0FBQ0QsS0FGRDtBQUdBLFNBQUtpRSxLQUFMLENBQVcsUUFBWCxFQUFxQiwrQkFBckIsRUFBc0RqRSxHQUFHLElBQUk7QUFDM0QsYUFBTyxLQUFLa0QsWUFBTCxDQUFrQmxELEdBQWxCLENBQVA7QUFDRCxLQUZEO0FBR0Q7O0FBalA4Qzs7O2VBb1BsQ0gsYSIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBQcm9taXNlUm91dGVyIGZyb20gJy4uL1Byb21pc2VSb3V0ZXInO1xuaW1wb3J0IHJlc3QgZnJvbSAnLi4vcmVzdCc7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuXG5jb25zdCBBTExPV0VEX0dFVF9RVUVSWV9LRVlTID0gW1xuICAna2V5cycsXG4gICdpbmNsdWRlJyxcbiAgJ2V4Y2x1ZGVLZXlzJyxcbiAgJ3JlYWRQcmVmZXJlbmNlJyxcbiAgJ2luY2x1ZGVSZWFkUHJlZmVyZW5jZScsXG4gICdzdWJxdWVyeVJlYWRQcmVmZXJlbmNlJyxcbl07XG5cbmV4cG9ydCBjbGFzcyBDbGFzc2VzUm91dGVyIGV4dGVuZHMgUHJvbWlzZVJvdXRlciB7XG4gIGNsYXNzTmFtZShyZXEpIHtcbiAgICByZXR1cm4gcmVxLnBhcmFtcy5jbGFzc05hbWU7XG4gIH1cblxuICBoYW5kbGVGaW5kKHJlcSkge1xuICAgIGNvbnN0IGJvZHkgPSBPYmplY3QuYXNzaWduKFxuICAgICAgcmVxLmJvZHksXG4gICAgICBDbGFzc2VzUm91dGVyLkpTT05Gcm9tUXVlcnkocmVxLnF1ZXJ5KVxuICAgICk7XG4gICAgY29uc3Qgb3B0aW9ucyA9IENsYXNzZXNSb3V0ZXIub3B0aW9uc0Zyb21Cb2R5KGJvZHkpO1xuICAgIGlmIChyZXEuY29uZmlnLm1heExpbWl0ICYmIGJvZHkubGltaXQgPiByZXEuY29uZmlnLm1heExpbWl0KSB7XG4gICAgICAvLyBTaWxlbnRseSByZXBsYWNlIHRoZSBsaW1pdCBvbiB0aGUgcXVlcnkgd2l0aCB0aGUgbWF4IGNvbmZpZ3VyZWRcbiAgICAgIG9wdGlvbnMubGltaXQgPSBOdW1iZXIocmVxLmNvbmZpZy5tYXhMaW1pdCk7XG4gICAgfVxuICAgIGlmIChib2R5LnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5KSB7XG4gICAgICBvcHRpb25zLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5ID0gU3RyaW5nKGJvZHkucmVkaXJlY3RDbGFzc05hbWVGb3JLZXkpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGJvZHkud2hlcmUgPT09ICdzdHJpbmcnKSB7XG4gICAgICBib2R5LndoZXJlID0gSlNPTi5wYXJzZShib2R5LndoZXJlKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3RcbiAgICAgIC5maW5kKFxuICAgICAgICByZXEuY29uZmlnLFxuICAgICAgICByZXEuYXV0aCxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUocmVxKSxcbiAgICAgICAgYm9keS53aGVyZSxcbiAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgcmVxLmluZm8uY2xpZW50U0RLXG4gICAgICApXG4gICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgIHJldHVybiB7IHJlc3BvbnNlOiByZXNwb25zZSB9O1xuICAgICAgfSk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSB7cmVzcG9uc2V9IG9iamVjdC5cbiAgaGFuZGxlR2V0KHJlcSkge1xuICAgIGNvbnN0IGJvZHkgPSBPYmplY3QuYXNzaWduKFxuICAgICAgcmVxLmJvZHksXG4gICAgICBDbGFzc2VzUm91dGVyLkpTT05Gcm9tUXVlcnkocmVxLnF1ZXJ5KVxuICAgICk7XG4gICAgY29uc3Qgb3B0aW9ucyA9IHt9O1xuXG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoYm9keSkpIHtcbiAgICAgIGlmIChBTExPV0VEX0dFVF9RVUVSWV9LRVlTLmluZGV4T2Yoa2V5KSA9PT0gLTEpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgJ0ltcHJvcGVyIGVuY29kZSBvZiBwYXJhbWV0ZXInXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBib2R5LmtleXMgPT09ICdzdHJpbmcnKSB7XG4gICAgICBvcHRpb25zLmtleXMgPSBib2R5LmtleXM7XG4gICAgfVxuICAgIGlmIChib2R5LmluY2x1ZGUpIHtcbiAgICAgIG9wdGlvbnMuaW5jbHVkZSA9IFN0cmluZyhib2R5LmluY2x1ZGUpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGJvZHkuZXhjbHVkZUtleXMgPT0gJ3N0cmluZycpIHtcbiAgICAgIG9wdGlvbnMuZXhjbHVkZUtleXMgPSBib2R5LmV4Y2x1ZGVLZXlzO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGJvZHkucmVhZFByZWZlcmVuY2UgPT09ICdzdHJpbmcnKSB7XG4gICAgICBvcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gYm9keS5yZWFkUHJlZmVyZW5jZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBib2R5LmluY2x1ZGVSZWFkUHJlZmVyZW5jZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIG9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlID0gYm9keS5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgYm9keS5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID09PSAnc3RyaW5nJykge1xuICAgICAgb3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gYm9keS5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIHJldHVybiByZXN0XG4gICAgICAuZ2V0KFxuICAgICAgICByZXEuY29uZmlnLFxuICAgICAgICByZXEuYXV0aCxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUocmVxKSxcbiAgICAgICAgcmVxLnBhcmFtcy5vYmplY3RJZCxcbiAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgcmVxLmluZm8uY2xpZW50U0RLXG4gICAgICApXG4gICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgIGlmICghcmVzcG9uc2UucmVzdWx0cyB8fCByZXNwb25zZS5yZXN1bHRzLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoaXMuY2xhc3NOYW1lKHJlcSkgPT09ICdfVXNlcicpIHtcbiAgICAgICAgICBkZWxldGUgcmVzcG9uc2UucmVzdWx0c1swXS5zZXNzaW9uVG9rZW47XG5cbiAgICAgICAgICBjb25zdCB1c2VyID0gcmVzcG9uc2UucmVzdWx0c1swXTtcblxuICAgICAgICAgIGlmIChyZXEuYXV0aC51c2VyICYmIHVzZXIub2JqZWN0SWQgPT0gcmVxLmF1dGgudXNlci5pZCkge1xuICAgICAgICAgICAgLy8gRm9yY2UgdGhlIHNlc3Npb24gdG9rZW5cbiAgICAgICAgICAgIHJlc3BvbnNlLnJlc3VsdHNbMF0uc2Vzc2lvblRva2VuID0gcmVxLmluZm8uc2Vzc2lvblRva2VuO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyByZXNwb25zZTogcmVzcG9uc2UucmVzdWx0c1swXSB9O1xuICAgICAgfSk7XG4gIH1cblxuICBoYW5kbGVDcmVhdGUocmVxKSB7XG4gICAgcmV0dXJuIHJlc3QuY3JlYXRlKFxuICAgICAgcmVxLmNvbmZpZyxcbiAgICAgIHJlcS5hdXRoLFxuICAgICAgdGhpcy5jbGFzc05hbWUocmVxKSxcbiAgICAgIHJlcS5ib2R5LFxuICAgICAgcmVxLmluZm8uY2xpZW50U0RLXG4gICAgKTtcbiAgfVxuXG4gIGhhbmRsZVVwZGF0ZShyZXEpIHtcbiAgICBjb25zdCB3aGVyZSA9IHsgb2JqZWN0SWQ6IHJlcS5wYXJhbXMub2JqZWN0SWQgfTtcbiAgICByZXR1cm4gcmVzdC51cGRhdGUoXG4gICAgICByZXEuY29uZmlnLFxuICAgICAgcmVxLmF1dGgsXG4gICAgICB0aGlzLmNsYXNzTmFtZShyZXEpLFxuICAgICAgd2hlcmUsXG4gICAgICByZXEuYm9keSxcbiAgICAgIHJlcS5pbmZvLmNsaWVudFNES1xuICAgICk7XG4gIH1cblxuICBoYW5kbGVEZWxldGUocmVxKSB7XG4gICAgcmV0dXJuIHJlc3RcbiAgICAgIC5kZWwoXG4gICAgICAgIHJlcS5jb25maWcsXG4gICAgICAgIHJlcS5hdXRoLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZShyZXEpLFxuICAgICAgICByZXEucGFyYW1zLm9iamVjdElkLFxuICAgICAgICByZXEuaW5mby5jbGllbnRTREtcbiAgICAgIClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHsgcmVzcG9uc2U6IHt9IH07XG4gICAgICB9KTtcbiAgfVxuXG4gIHN0YXRpYyBKU09ORnJvbVF1ZXJ5KHF1ZXJ5KSB7XG4gICAgY29uc3QganNvbiA9IHt9O1xuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIF8uZW50cmllcyhxdWVyeSkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGpzb25ba2V5XSA9IEpTT04ucGFyc2UodmFsdWUpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBqc29uW2tleV0gPSB2YWx1ZTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGpzb247XG4gIH1cblxuICBzdGF0aWMgb3B0aW9uc0Zyb21Cb2R5KGJvZHkpIHtcbiAgICBjb25zdCBhbGxvd0NvbnN0cmFpbnRzID0gW1xuICAgICAgJ3NraXAnLFxuICAgICAgJ2xpbWl0JyxcbiAgICAgICdvcmRlcicsXG4gICAgICAnY291bnQnLFxuICAgICAgJ2tleXMnLFxuICAgICAgJ2V4Y2x1ZGVLZXlzJyxcbiAgICAgICdpbmNsdWRlJyxcbiAgICAgICdpbmNsdWRlQWxsJyxcbiAgICAgICdyZWRpcmVjdENsYXNzTmFtZUZvcktleScsXG4gICAgICAnd2hlcmUnLFxuICAgICAgJ3JlYWRQcmVmZXJlbmNlJyxcbiAgICAgICdpbmNsdWRlUmVhZFByZWZlcmVuY2UnLFxuICAgICAgJ3N1YnF1ZXJ5UmVhZFByZWZlcmVuY2UnLFxuICAgICAgJ2hpbnQnLFxuICAgICAgJ2V4cGxhaW4nLFxuICAgIF07XG5cbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhib2R5KSkge1xuICAgICAgaWYgKGFsbG93Q29uc3RyYWludHMuaW5kZXhPZihrZXkpID09PSAtMSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICBgSW52YWxpZCBwYXJhbWV0ZXIgZm9yIHF1ZXJ5OiAke2tleX1gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IG9wdGlvbnMgPSB7fTtcbiAgICBpZiAoYm9keS5za2lwKSB7XG4gICAgICBvcHRpb25zLnNraXAgPSBOdW1iZXIoYm9keS5za2lwKTtcbiAgICB9XG4gICAgaWYgKGJvZHkubGltaXQgfHwgYm9keS5saW1pdCA9PT0gMCkge1xuICAgICAgb3B0aW9ucy5saW1pdCA9IE51bWJlcihib2R5LmxpbWl0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3B0aW9ucy5saW1pdCA9IE51bWJlcigxMDApO1xuICAgIH1cbiAgICBpZiAoYm9keS5vcmRlcikge1xuICAgICAgb3B0aW9ucy5vcmRlciA9IFN0cmluZyhib2R5Lm9yZGVyKTtcbiAgICB9XG4gICAgaWYgKGJvZHkuY291bnQpIHtcbiAgICAgIG9wdGlvbnMuY291bnQgPSB0cnVlO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGJvZHkua2V5cyA9PSAnc3RyaW5nJykge1xuICAgICAgb3B0aW9ucy5rZXlzID0gYm9keS5rZXlzO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGJvZHkuZXhjbHVkZUtleXMgPT0gJ3N0cmluZycpIHtcbiAgICAgIG9wdGlvbnMuZXhjbHVkZUtleXMgPSBib2R5LmV4Y2x1ZGVLZXlzO1xuICAgIH1cbiAgICBpZiAoYm9keS5pbmNsdWRlKSB7XG4gICAgICBvcHRpb25zLmluY2x1ZGUgPSBTdHJpbmcoYm9keS5pbmNsdWRlKTtcbiAgICB9XG4gICAgaWYgKGJvZHkuaW5jbHVkZUFsbCkge1xuICAgICAgb3B0aW9ucy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBib2R5LnJlYWRQcmVmZXJlbmNlID09PSAnc3RyaW5nJykge1xuICAgICAgb3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IGJvZHkucmVhZFByZWZlcmVuY2U7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgYm9keS5pbmNsdWRlUmVhZFByZWZlcmVuY2UgPT09ICdzdHJpbmcnKSB7XG4gICAgICBvcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSA9IGJvZHkuaW5jbHVkZVJlYWRQcmVmZXJlbmNlO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGJvZHkuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIG9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IGJvZHkuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgYm9keS5oaW50ICYmXG4gICAgICAodHlwZW9mIGJvZHkuaGludCA9PT0gJ3N0cmluZycgfHwgdHlwZW9mIGJvZHkuaGludCA9PT0gJ29iamVjdCcpXG4gICAgKSB7XG4gICAgICBvcHRpb25zLmhpbnQgPSBib2R5LmhpbnQ7XG4gICAgfVxuICAgIGlmIChib2R5LmV4cGxhaW4pIHtcbiAgICAgIG9wdGlvbnMuZXhwbGFpbiA9IGJvZHkuZXhwbGFpbjtcbiAgICB9XG4gICAgcmV0dXJuIG9wdGlvbnM7XG4gIH1cblxuICBtb3VudFJvdXRlcygpIHtcbiAgICB0aGlzLnJvdXRlKCdHRVQnLCAnL2NsYXNzZXMvOmNsYXNzTmFtZScsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVGaW5kKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnR0VUJywgJy9jbGFzc2VzLzpjbGFzc05hbWUvOm9iamVjdElkJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUdldChyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ1BPU1QnLCAnL2NsYXNzZXMvOmNsYXNzTmFtZScsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVDcmVhdGUocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdQVVQnLCAnL2NsYXNzZXMvOmNsYXNzTmFtZS86b2JqZWN0SWQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlVXBkYXRlKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnREVMRVRFJywgJy9jbGFzc2VzLzpjbGFzc05hbWUvOm9iamVjdElkJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZURlbGV0ZShyZXEpO1xuICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IENsYXNzZXNSb3V0ZXI7XG4iXX0=
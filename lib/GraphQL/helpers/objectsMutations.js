"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.deleteObject = exports.updateObject = exports.createObject = void 0;

var _rest = _interopRequireDefault(require("../../rest"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const createObject = async (className, fields, config, auth, info) => {
  if (!fields) {
    fields = {};
  }

  return (await _rest.default.create(config, auth, className, fields, info.clientSDK)).response;
};

exports.createObject = createObject;

const updateObject = async (className, objectId, fields, config, auth, info) => {
  if (!fields) {
    fields = {};
  }

  return (await _rest.default.update(config, auth, className, {
    objectId
  }, fields, info.clientSDK)).response;
};

exports.updateObject = updateObject;

const deleteObject = async (className, objectId, config, auth, info) => {
  await _rest.default.del(config, auth, className, objectId, info.clientSDK);
  return true;
};

exports.deleteObject = deleteObject;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML2hlbHBlcnMvb2JqZWN0c011dGF0aW9ucy5qcyJdLCJuYW1lcyI6WyJjcmVhdGVPYmplY3QiLCJjbGFzc05hbWUiLCJmaWVsZHMiLCJjb25maWciLCJhdXRoIiwiaW5mbyIsInJlc3QiLCJjcmVhdGUiLCJjbGllbnRTREsiLCJyZXNwb25zZSIsInVwZGF0ZU9iamVjdCIsIm9iamVjdElkIiwidXBkYXRlIiwiZGVsZXRlT2JqZWN0IiwiZGVsIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7Ozs7QUFFQSxNQUFNQSxZQUFZLEdBQUcsT0FBT0MsU0FBUCxFQUFrQkMsTUFBbEIsRUFBMEJDLE1BQTFCLEVBQWtDQyxJQUFsQyxFQUF3Q0MsSUFBeEMsS0FBaUQ7QUFDcEUsTUFBSSxDQUFDSCxNQUFMLEVBQWE7QUFDWEEsSUFBQUEsTUFBTSxHQUFHLEVBQVQ7QUFDRDs7QUFFRCxTQUFPLENBQUMsTUFBTUksY0FBS0MsTUFBTCxDQUFZSixNQUFaLEVBQW9CQyxJQUFwQixFQUEwQkgsU0FBMUIsRUFBcUNDLE1BQXJDLEVBQTZDRyxJQUFJLENBQUNHLFNBQWxELENBQVAsRUFDSkMsUUFESDtBQUVELENBUEQ7Ozs7QUFTQSxNQUFNQyxZQUFZLEdBQUcsT0FDbkJULFNBRG1CLEVBRW5CVSxRQUZtQixFQUduQlQsTUFIbUIsRUFJbkJDLE1BSm1CLEVBS25CQyxJQUxtQixFQU1uQkMsSUFObUIsS0FPaEI7QUFDSCxNQUFJLENBQUNILE1BQUwsRUFBYTtBQUNYQSxJQUFBQSxNQUFNLEdBQUcsRUFBVDtBQUNEOztBQUVELFNBQU8sQ0FBQyxNQUFNSSxjQUFLTSxNQUFMLENBQ1pULE1BRFksRUFFWkMsSUFGWSxFQUdaSCxTQUhZLEVBSVo7QUFBRVUsSUFBQUE7QUFBRixHQUpZLEVBS1pULE1BTFksRUFNWkcsSUFBSSxDQUFDRyxTQU5PLENBQVAsRUFPSkMsUUFQSDtBQVFELENBcEJEOzs7O0FBc0JBLE1BQU1JLFlBQVksR0FBRyxPQUFPWixTQUFQLEVBQWtCVSxRQUFsQixFQUE0QlIsTUFBNUIsRUFBb0NDLElBQXBDLEVBQTBDQyxJQUExQyxLQUFtRDtBQUN0RSxRQUFNQyxjQUFLUSxHQUFMLENBQVNYLE1BQVQsRUFBaUJDLElBQWpCLEVBQXVCSCxTQUF2QixFQUFrQ1UsUUFBbEMsRUFBNENOLElBQUksQ0FBQ0csU0FBakQsQ0FBTjtBQUNBLFNBQU8sSUFBUDtBQUNELENBSEQiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgcmVzdCBmcm9tICcuLi8uLi9yZXN0JztcblxuY29uc3QgY3JlYXRlT2JqZWN0ID0gYXN5bmMgKGNsYXNzTmFtZSwgZmllbGRzLCBjb25maWcsIGF1dGgsIGluZm8pID0+IHtcbiAgaWYgKCFmaWVsZHMpIHtcbiAgICBmaWVsZHMgPSB7fTtcbiAgfVxuXG4gIHJldHVybiAoYXdhaXQgcmVzdC5jcmVhdGUoY29uZmlnLCBhdXRoLCBjbGFzc05hbWUsIGZpZWxkcywgaW5mby5jbGllbnRTREspKVxuICAgIC5yZXNwb25zZTtcbn07XG5cbmNvbnN0IHVwZGF0ZU9iamVjdCA9IGFzeW5jIChcbiAgY2xhc3NOYW1lLFxuICBvYmplY3RJZCxcbiAgZmllbGRzLFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGluZm9cbikgPT4ge1xuICBpZiAoIWZpZWxkcykge1xuICAgIGZpZWxkcyA9IHt9O1xuICB9XG5cbiAgcmV0dXJuIChhd2FpdCByZXN0LnVwZGF0ZShcbiAgICBjb25maWcsXG4gICAgYXV0aCxcbiAgICBjbGFzc05hbWUsXG4gICAgeyBvYmplY3RJZCB9LFxuICAgIGZpZWxkcyxcbiAgICBpbmZvLmNsaWVudFNES1xuICApKS5yZXNwb25zZTtcbn07XG5cbmNvbnN0IGRlbGV0ZU9iamVjdCA9IGFzeW5jIChjbGFzc05hbWUsIG9iamVjdElkLCBjb25maWcsIGF1dGgsIGluZm8pID0+IHtcbiAgYXdhaXQgcmVzdC5kZWwoY29uZmlnLCBhdXRoLCBjbGFzc05hbWUsIG9iamVjdElkLCBpbmZvLmNsaWVudFNESyk7XG4gIHJldHVybiB0cnVlO1xufTtcblxuZXhwb3J0IHsgY3JlYXRlT2JqZWN0LCB1cGRhdGVPYmplY3QsIGRlbGV0ZU9iamVjdCB9O1xuIl19
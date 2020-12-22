"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.IAPValidationRouter = void 0;

var _PromiseRouter = _interopRequireDefault(require("../PromiseRouter"));

var _node = _interopRequireDefault(require("parse/node"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const request = require('../request');

const rest = require('../rest');

// TODO move validation logic in IAPValidationController
const IAP_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const IAP_PRODUCTION_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APP_STORE_ERRORS = {
  21000: 'The App Store could not read the JSON object you provided.',
  21002: 'The data in the receipt-data property was malformed or missing.',
  21003: 'The receipt could not be authenticated.',
  21004: 'The shared secret you provided does not match the shared secret on file for your account.',
  21005: 'The receipt server is not currently available.',
  21006: 'This receipt is valid but the subscription has expired.',
  21007: 'This receipt is from the test environment, but it was sent to the production environment for verification. Send it to the test environment instead.',
  21008: 'This receipt is from the production environment, but it was sent to the test environment for verification. Send it to the production environment instead.'
};

function appStoreError(status) {
  status = parseInt(status);
  var errorString = APP_STORE_ERRORS[status] || 'unknown error.';
  return {
    status: status,
    error: errorString
  };
}

function validateWithAppStore(url, receipt) {
  return request({
    url: url,
    method: 'POST',
    body: {
      'receipt-data': receipt
    },
    headers: {
      'Content-Type': 'application/json'
    }
  }).then(httpResponse => {
    const body = httpResponse.data;

    if (body && body.status === 0) {
      // No need to pass anything, status is OK
      return;
    } // receipt is from test and should go to test


    throw body;
  });
}

function getFileForProductIdentifier(productIdentifier, req) {
  return rest.find(req.config, req.auth, '_Product', {
    productIdentifier: productIdentifier
  }, undefined, req.info.clientSDK, req.info.context).then(function (result) {
    const products = result.results;

    if (!products || products.length != 1) {
      // Error not found or too many
      throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
    }

    var download = products[0].download;
    return Promise.resolve({
      response: download
    });
  });
}

class IAPValidationRouter extends _PromiseRouter.default {
  handleRequest(req) {
    let receipt = req.body.receipt;
    const productIdentifier = req.body.productIdentifier;

    if (!receipt || !productIdentifier) {
      // TODO: Error, malformed request
      throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'missing receipt or productIdentifier');
    } // Transform the object if there
    // otherwise assume it's in Base64 already


    if (typeof receipt == 'object') {
      if (receipt['__type'] == 'Bytes') {
        receipt = receipt.base64;
      }
    }

    if (process.env.TESTING == '1' && req.body.bypassAppStoreValidation) {
      return getFileForProductIdentifier(productIdentifier, req);
    }

    function successCallback() {
      return getFileForProductIdentifier(productIdentifier, req);
    }

    function errorCallback(error) {
      return Promise.resolve({
        response: appStoreError(error.status)
      });
    }

    return validateWithAppStore(IAP_PRODUCTION_URL, receipt).then(() => {
      return successCallback();
    }, error => {
      if (error.status == 21007) {
        return validateWithAppStore(IAP_SANDBOX_URL, receipt).then(() => {
          return successCallback();
        }, error => {
          return errorCallback(error);
        });
      }

      return errorCallback(error);
    });
  }

  mountRoutes() {
    this.route('POST', '/validate_purchase', this.handleRequest);
  }

}

exports.IAPValidationRouter = IAPValidationRouter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Sb3V0ZXJzL0lBUFZhbGlkYXRpb25Sb3V0ZXIuanMiXSwibmFtZXMiOlsicmVxdWVzdCIsInJlcXVpcmUiLCJyZXN0IiwiSUFQX1NBTkRCT1hfVVJMIiwiSUFQX1BST0RVQ1RJT05fVVJMIiwiQVBQX1NUT1JFX0VSUk9SUyIsImFwcFN0b3JlRXJyb3IiLCJzdGF0dXMiLCJwYXJzZUludCIsImVycm9yU3RyaW5nIiwiZXJyb3IiLCJ2YWxpZGF0ZVdpdGhBcHBTdG9yZSIsInVybCIsInJlY2VpcHQiLCJtZXRob2QiLCJib2R5IiwiaGVhZGVycyIsInRoZW4iLCJodHRwUmVzcG9uc2UiLCJkYXRhIiwiZ2V0RmlsZUZvclByb2R1Y3RJZGVudGlmaWVyIiwicHJvZHVjdElkZW50aWZpZXIiLCJyZXEiLCJmaW5kIiwiY29uZmlnIiwiYXV0aCIsInVuZGVmaW5lZCIsImluZm8iLCJjbGllbnRTREsiLCJjb250ZXh0IiwicmVzdWx0IiwicHJvZHVjdHMiLCJyZXN1bHRzIiwibGVuZ3RoIiwiUGFyc2UiLCJFcnJvciIsIk9CSkVDVF9OT1RfRk9VTkQiLCJkb3dubG9hZCIsIlByb21pc2UiLCJyZXNvbHZlIiwicmVzcG9uc2UiLCJJQVBWYWxpZGF0aW9uUm91dGVyIiwiUHJvbWlzZVJvdXRlciIsImhhbmRsZVJlcXVlc3QiLCJJTlZBTElEX0pTT04iLCJiYXNlNjQiLCJwcm9jZXNzIiwiZW52IiwiVEVTVElORyIsImJ5cGFzc0FwcFN0b3JlVmFsaWRhdGlvbiIsInN1Y2Nlc3NDYWxsYmFjayIsImVycm9yQ2FsbGJhY2siLCJtb3VudFJvdXRlcyIsInJvdXRlIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7O0FBR0E7Ozs7QUFGQSxNQUFNQSxPQUFPLEdBQUdDLE9BQU8sQ0FBQyxZQUFELENBQXZCOztBQUNBLE1BQU1DLElBQUksR0FBR0QsT0FBTyxDQUFDLFNBQUQsQ0FBcEI7O0FBR0E7QUFDQSxNQUFNRSxlQUFlLEdBQUcsZ0RBQXhCO0FBQ0EsTUFB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QUFFRDBDLEVBQUFBLFdBQVcsR0FBRztBQUNaLFNBQUtDLEtBQUwsQ0FBVyxNQUFYLEVBQW1CLG9CQUFuQixFQUF5QyxLQUFLVixhQUE5QztBQUNEOztBQXhEb0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUHJvbWlzZVJvdXRlciBmcm9tICcuLi9Qcm9taXNlUm91dGVyJztcbmNvbnN0IHJlcXVlc3QgPSByZXF1aXJlKCcuLi9yZXF1ZXN0Jyk7XG5jb25zdCByZXN0ID0gcmVxdWlyZSgnLi4vcmVzdCcpO1xuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuXG4vLyBUT0RPIG1vdmUgdmFsaWRhdGlvbiBsb2dpYyBpbiBJQVBWYWxpZGF0aW9uQ29udHJvbGxlclxuY29uc3QgSUFQX1NBTkRCT1hfVVJMID0gJ2h0dHBzOi8vc2FuZGJveC5pdHVuZXMuYXBwbGUuY29tL3ZlcmlmeVJlY2VpcHQnO1xuY29uc3QgSUFQX1BST0RVQ1RJT05fVVJMID0gJ2h0dHBzOi8vYnV5Lml0dW5lcy5hcHBsZS5jb20vdmVyaWZ5UmVjZWlwdCc7XG5cbmNvbnN0IEFQUF9TVE9SRV9FUlJPUlMgPSB7XG4gIDIxMDAwOiAnVGhlIEFwcCBTdG9yZSBjb3VsZCBub3QgcmVhZCB0aGUgSlNPTiBvYmplY3QgeW91IHByb3ZpZGVkLicsXG4gIDIxMDAyOiAnVGhlIGRhdGEgaW4gdGhlIHJlY2VpcHQtZGF0YSBwcm9wZXJ0eSB3YXMgbWFsZm9ybWVkIG9yIG1pc3NpbmcuJyxcbiAgMjEwMDM6ICdUaGUgcmVjZWlwdCBjb3VsZCBub3QgYmUgYXV0aGVudGljYXRlZC4nLFxuICAyMTAwNDogJ1RoZSBzaGFyZWQgc2VjcmV0IHlvdSBwcm92aWRlZCBkb2VzIG5vdCBtYXRjaCB0aGUgc2hhcmVkIHNlY3JldCBvbiBmaWxlIGZvciB5b3VyIGFjY291bnQuJyxcbiAgMjEwMDU6ICdUaGUgcmVjZWlwdCBzZXJ2ZXIgaXMgbm90IGN1cnJlbnRseSBhdmFpbGFibGUuJyxcbiAgMjEwMDY6ICdUaGlzIHJlY2VpcHQgaXMgdmFsaWQgYnV0IHRoZSBzdWJzY3JpcHRpb24gaGFzIGV4cGlyZWQuJyxcbiAgMjEwMDc6ICdUaGlzIHJlY2VpcHQgaXMgZnJvbSB0aGUgdGVzdCBlbnZpcm9ubWVudCwgYnV0IGl0IHdhcyBzZW50IHRvIHRoZSBwcm9kdWN0aW9uIGVudmlyb25tZW50IGZvciB2ZXJpZmljYXRpb24uIFNlbmQgaXQgdG8gdGhlIHRlc3QgZW52aXJvbm1lbnQgaW5zdGVhZC4nLFxuICAyMTAwODogJ1RoaXMgcmVjZWlwdCBpcyBmcm9tIHRoZSBwcm9kdWN0aW9uIGVudmlyb25tZW50LCBidXQgaXQgd2FzIHNlbnQgdG8gdGhlIHRlc3QgZW52aXJvbm1lbnQgZm9yIHZlcmlmaWNhdGlvbi4gU2VuZCBpdCB0byB0aGUgcHJvZHVjdGlvbiBlbnZpcm9ubWVudCBpbnN0ZWFkLicsXG59O1xuXG5mdW5jdGlvbiBhcHBTdG9yZUVycm9yKHN0YXR1cykge1xuICBzdGF0dXMgPSBwYXJzZUludChzdGF0dXMpO1xuICB2YXIgZXJyb3JTdHJpbmcgPSBBUFBfU1RPUkVfRVJST1JTW3N0YXR1c10gfHwgJ3Vua25vd24gZXJyb3IuJztcbiAgcmV0dXJuIHsgc3RhdHVzOiBzdGF0dXMsIGVycm9yOiBlcnJvclN0cmluZyB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVdpdGhBcHBTdG9yZSh1cmwsIHJlY2VpcHQpIHtcbiAgcmV0dXJuIHJlcXVlc3Qoe1xuICAgIHVybDogdXJsLFxuICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgIGJvZHk6IHsgJ3JlY2VpcHQtZGF0YSc6IHJlY2VpcHQgfSxcbiAgICBoZWFkZXJzOiB7XG4gICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgIH0sXG4gIH0pLnRoZW4oaHR0cFJlc3BvbnNlID0+IHtcbiAgICBjb25zdCBib2R5ID0gaHR0cFJlc3BvbnNlLmRhdGE7XG4gICAgaWYgKGJvZHkgJiYgYm9keS5zdGF0dXMgPT09IDApIHtcbiAgICAgIC8vIE5vIG5lZWQgdG8gcGFzcyBhbnl0aGluZywgc3RhdHVzIGlzIE9LXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIHJlY2VpcHQgaXMgZnJvbSB0ZXN0IGFuZCBzaG91bGQgZ28gdG8gdGVzdFxuICAgIHRocm93IGJvZHk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBnZXRGaWxlRm9yUHJvZHVjdElkZW50aWZpZXIocHJvZHVjdElkZW50aWZpZXIsIHJlcSkge1xuICByZXR1cm4gcmVzdFxuICAgIC5maW5kKFxuICAgICAgcmVxLmNvbmZpZyxcbiAgICAgIHJlcS5hdXRoLFxuICAgICAgJ19Qcm9kdWN0JyxcbiAgICAgIHsgcHJvZHVjdElkZW50aWZpZXI6IHByb2R1Y3RJZGVudGlmaWVyIH0sXG4gICAgICB1bmRlZmluZWQsXG4gICAgICByZXEuaW5mby5jbGllbnRTREssXG4gICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgKVxuICAgIC50aGVuKGZ1bmN0aW9uIChyZXN1bHQpIHtcbiAgICAgIGNvbnN0IHByb2R1Y3RzID0gcmVzdWx0LnJlc3VsdHM7XG4gICAgICBpZiAoIXByb2R1Y3RzIHx8IHByb2R1Y3RzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgIC8vIEVycm9yIG5vdCBmb3VuZCBvciB0b28gbWFueVxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAnT2JqZWN0IG5vdCBmb3VuZC4nXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHZhciBkb3dubG9hZCA9IHByb2R1Y3RzWzBdLmRvd25sb2FkO1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IHJlc3BvbnNlOiBkb3dubG9hZCB9KTtcbiAgICB9KTtcbn1cblxuZXhwb3J0IGNsYXNzIElBUFZhbGlkYXRpb25Sb3V0ZXIgZXh0ZW5kcyBQcm9taXNlUm91dGVyIHtcbiAgaGFuZGxlUmVxdWVzdChyZXEpIHtcbiAgICBsZXQgcmVjZWlwdCA9IHJlcS5ib2R5LnJlY2VpcHQ7XG4gICAgY29uc3QgcHJvZHVjdElkZW50aWZpZXIgPSByZXEuYm9keS5wcm9kdWN0SWRlbnRpZmllcjtcblxuICAgIGlmICghcmVjZWlwdCB8fCAhcHJvZHVjdElkZW50aWZpZXIpIHtcbiAgICAgIC8vIFRPRE86IEVycm9yLCBtYWxmb3JtZWQgcmVxdWVzdFxuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICdtaXNzaW5nIHJlY2VpcHQgb3IgcHJvZHVjdElkZW50aWZpZXInXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIFRyYW5zZm9ybSB0aGUgb2JqZWN0IGlmIHRoZXJlXG4gICAgLy8gb3RoZXJ3aXNlIGFzc3VtZSBpdCdzIGluIEJhc2U2NCBhbHJlYWR5XG4gICAgaWYgKHR5cGVvZiByZWNlaXB0ID09ICdvYmplY3QnKSB7XG4gICAgICBpZiAocmVjZWlwdFsnX190eXBlJ10gPT0gJ0J5dGVzJykge1xuICAgICAgICByZWNlaXB0ID0gcmVjZWlwdC5iYXNlNjQ7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHByb2Nlc3MuZW52LlRFU1RJTkcgPT0gJzEnICYmIHJlcS5ib2R5LmJ5cGFzc0FwcFN0b3JlVmFsaWRhdGlvbikge1xuICAgICAgcmV0dXJuIGdldEZpbGVGb3JQcm9kdWN0SWRlbnRpZmllcihwcm9kdWN0SWRlbnRpZmllciwgcmVxKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzdWNjZXNzQ2FsbGJhY2soKSB7XG4gICAgICByZXR1cm4gZ2V0RmlsZUZvclByb2R1Y3RJZGVudGlmaWVyKHByb2R1Y3RJZGVudGlmaWVyLCByZXEpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGVycm9yQ2FsbGJhY2soZXJyb3IpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyByZXNwb25zZTogYXBwU3RvcmVFcnJvcihlcnJvci5zdGF0dXMpIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB2YWxpZGF0ZVdpdGhBcHBTdG9yZShJQVBfUFJPRFVDVElPTl9VUkwsIHJlY2VpcHQpLnRoZW4oXG4gICAgICAoKSA9PiB7XG4gICAgICAgIHJldHVybiBzdWNjZXNzQ2FsbGJhY2soKTtcbiAgICAgIH0sXG4gICAgICBlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5zdGF0dXMgPT0gMjEwMDcpIHtcbiAgICAgICAgICByZXR1cm4gdmFsaWRhdGVXaXRoQXBwU3RvcmUoSUFQX1NBTkRCT1hfVVJMLCByZWNlaXB0KS50aGVuKFxuICAgICAgICAgICAgKCkgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gc3VjY2Vzc0NhbGxiYWNrKCk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZXJyb3IgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gZXJyb3JDYWxsYmFjayhlcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBlcnJvckNhbGxiYWNrKGVycm9yKTtcbiAgICAgIH1cbiAgICApO1xuICB9XG5cbiAgbW91bnRSb3V0ZXMoKSB7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvdmFsaWRhdGVfcHVyY2hhc2UnLCB0aGlzLmhhbmRsZVJlcXVlc3QpO1xuICB9XG59XG4iXX0=
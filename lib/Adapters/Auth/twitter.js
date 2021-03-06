"use strict";

// Helper functions for accessing the twitter API.
var OAuth = require('./OAuth1Client');

var Parse = require('parse/node').Parse; // Returns a promise that fulfills iff this user id is valid.


function validateAuthData(authData, options) {
  if (!options) {
    throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Twitter auth configuration missing');
  }

  options = handleMultipleConfigurations(authData, options);
  var client = new OAuth(options);
  client.host = 'api.twitter.com';
  client.auth_token = authData.auth_token;
  client.auth_token_secret = authData.auth_token_secret;
  return client.get('/1.1/account/verify_credentials.json').then(data => {
    if (data && data.id_str == '' + authData.id) {
      return;
    }

    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Twitter auth is invalid for this user.');
  });
} // Returns a promise that fulfills iff this app id is valid.


function validateAppId() {
  return Promise.resolve();
}

function handleMultipleConfigurations(authData, options) {
  if (Array.isArray(options)) {
    const consumer_key = authData.consumer_key;

    if (!consumer_key) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Twitter auth is invalid for this user.');
    }

    options = options.filter(option => {
      return option.consumer_key == consumer_key;
    });

    if (options.length == 0) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Twitter auth is invalid for this user.');
    }

    options = options[0];
  }

  return options;
}

module.exports = {
  validateAppId,
  validateAuthData,
  handleMultipleConfigurations
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9BdXRoL3R3aXR0ZXIuanMiXSwibmFtZXMiOlsiT0F1dGgiLCJyZXF1aXJlIiwiUGFyc2UiLCJ2YWxpZGF0ZUF1dGhEYXRhIiwiYXV0aERhdGEiLCJvcHRpb25zIiwiRXJyb3IiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJoYW5kbGVNdWx0aXBsZUNvbmZpZ3VyYXRpb25zIiwiY2xpZW50IiwiaG9zdCIsImF1dGhfdG9rZW4iLCJhdXRoX3Rva2VuX3NlY3JldCIsImdldCIsInRoZW4iLCJkYXRhIiwiaWRfc3RyIiwiaWQiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwidmFsaWRhdGVBcHBJZCIsIlByb21pc2UiLCJyZXNvbHZlIiwiQXJyYXkiLCJpc0FycmF5IiwiY29uc3VtZXJfa2V5IiwiZmlsdGVyIiwib3B0aW9uIiwibGVuZ3RoIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7QUFBQTtBQUNBLElBQUlBLEtBQUssR0FBR0MsT0FBTyxDQUFDLGdCQUFELENBQW5COztBQUNBLElBQUlDLEtBQUssR0FBR0QsT0FBTyxDQUFDLFlBQUQsQ0FBUCxDQUFzQkMsS0FBbEMsQyxDQUVBOzs7QUFDQSxTQUFTQyxnQkFBVCxDQUEwQkMsUUFBMUIsRUFBb0NDLE9BQXBDLEVBQTZDO0FBQzNDLE1BQUksQ0FBQ0EsT0FBTCxFQUFjO0FBQ1osVUFBTSxJQUFJSCxLQUFLLENBQUNJLEtBQVYsQ0FDSkosS0FBSyxDQUFDSSxLQUFOLENBQVlDLHFCQURSLEVBRUosb0NBRkksQ0FBTjtBQUlEOztBQUNERixFQUFBQSxPQUFPLEdBQUdHLDRCQUE0QixDQUFDSixRQUFELEVBQVdDLE9BQVgsQ0FBdEM7QUFDQSxNQUFJSSxNQUFNLEdBQUcsSUFBSVQsS0FBSixDQUFVSyxPQUFWLENBQWI7QUFDQUksRUFBQUEsTUFBTSxDQUFDQyxJQUFQLEdBQWMsaUJBQWQ7QUFDQUQsRUFBQUEsTUFBTSxDQUFDRSxVQUFQLEdBQW9CUCxRQUFRLENBQUNPLFVBQTdCO0FBQ0FGLEVBQUFBLE1BQU0sQ0FBQ0csaUJBQVAsR0FBMkJSLFFBQVEsQ0FBQ1EsaUJBQXBDO0FBRUEsU0FBT0gsTUFBTSxDQUFDSSxHQUFQLENBQVcsc0NBQVgsRUFBbURDLElBQW5ELENBQXdEQyxJQUFJLElBQUk7QUFDckUsUUFBSUEsSUFBSSxJQUFJQSxJQUFJLENBQUNDLE1BQUwsSUFBZSxLQUFLWixRQUFRLENBQUNhLEVBQXpDLEVBQTZDO0FBQzNDO0FBQ0Q7O0FBQ0QsVUFBTSxJQUFJZixLQUFLLENBQUNJLEtBQVYsQ0FDSkosS0FBSyxDQUFDSSxLQUFOLENBQVlZLGdCQURSLEVBRUosd0NBRkksQ0FBTjtBQUlELEdBUk0sQ0FBUDtBQVNELEMsQ0FFRDs7O0FBQ0EsU0FBU0MsYUFBVCxHQUF5QjtBQUN2QixTQUFPQyxPQUFPLENBQUNDLE9BQVIsRUFBUDtBQUNEOztBQUVELFNBQVNiLDRCQUFULENBQXNDSixRQUF0QyxFQUFnREMsT0FBaEQsRUFBeUQ7QUFDdkQsTUFBSWlCLEtBQUssQ0FBQ0MsT0FBTixDQUFjbEIsT0FBZCxDQUFKLEVBQTRCO0FBQzFCLFVBQU1tQixZQUFZLEdBQUdwQixRQUFRLENBQUNvQixZQUE5Qjs7QUFDQSxRQUFJLENBQUNBLFlBQUwsRUFBbUI7QUFDakIsWUFBTSxJQUFJdEIsS0FBSyxDQUFDSSxLQUFWLENBQ0pKLEtBQUssQ0FBQ0ksS0FBTixDQUFZWSxnQkFEUixFQUVKLHdDQUZJLENBQU47QUFJRDs7QUFDRGIsSUFBQUEsT0FBTyxHQUFHQSxPQUFPLENBQUNvQixNQUFSLENBQWVDLE1BQU0sSUFBSTtBQUNqQyxhQUFPQSxNQUFNLENBQUNGLFlBQVAsSUFBdUJBLFlBQTlCO0FBQ0QsS0FGUyxDQUFWOztBQUlBLFFBQUluQixPQUFPLENBQUNzQixNQUFSLElBQWtCLENBQXRCLEVBQXlCO0FBQ3ZCLFlBQU0sSUFBSXpCLEtBQUssQ0FBQ0ksS0FBVixDQUNKSixLQUFLLENBQUNJLEtBQU4sQ0FBWVksZ0JBRFIsRUFFSix3Q0FGSSxDQUFOO0FBSUQ7O0FBQ0RiLElBQUFBLE9BQU8sR0FBR0EsT0FBTyxDQUFDLENBQUQsQ0FBakI7QUFDRDs7QUFDRCxTQUFPQSxPQUFQO0FBQ0Q7O0FBRUR1QixNQUFNLENBQUNDLE9BQVAsR0FBaUI7QUFDZlYsRUFBQUEsYUFEZTtBQUVmaEIsRUFBQUEsZ0JBRmU7QUFHZkssRUFBQUE7QUFIZSxDQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIi8vIEhlbHBlciBmdW5jdGlvbnMgZm9yIGFjY2Vzc2luZyB0aGUgdHdpdHRlciBBUEkuXG52YXIgT0F1dGggPSByZXF1aXJlKCcuL09BdXRoMUNsaWVudCcpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpLlBhcnNlO1xuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IGZ1bGZpbGxzIGlmZiB0aGlzIHVzZXIgaWQgaXMgdmFsaWQuXG5mdW5jdGlvbiB2YWxpZGF0ZUF1dGhEYXRhKGF1dGhEYXRhLCBvcHRpb25zKSB7XG4gIGlmICghb3B0aW9ucykge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUixcbiAgICAgICdUd2l0dGVyIGF1dGggY29uZmlndXJhdGlvbiBtaXNzaW5nJ1xuICAgICk7XG4gIH1cbiAgb3B0aW9ucyA9IGhhbmRsZU11bHRpcGxlQ29uZmlndXJhdGlvbnMoYXV0aERhdGEsIG9wdGlvbnMpO1xuICB2YXIgY2xpZW50ID0gbmV3IE9BdXRoKG9wdGlvbnMpO1xuICBjbGllbnQuaG9zdCA9ICdhcGkudHdpdHRlci5jb20nO1xuICBjbGllbnQuYXV0aF90b2tlbiA9IGF1dGhEYXRhLmF1dGhfdG9rZW47XG4gIGNsaWVudC5hdXRoX3Rva2VuX3NlY3JldCA9IGF1dGhEYXRhLmF1dGhfdG9rZW5fc2VjcmV0O1xuXG4gIHJldHVybiBjbGllbnQuZ2V0KCcvMS4xL2FjY291bnQvdmVyaWZ5X2NyZWRlbnRpYWxzLmpzb24nKS50aGVuKGRhdGEgPT4ge1xuICAgIGlmIChkYXRhICYmIGRhdGEuaWRfc3RyID09ICcnICsgYXV0aERhdGEuaWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICdUd2l0dGVyIGF1dGggaXMgaW52YWxpZCBmb3IgdGhpcyB1c2VyLidcbiAgICApO1xuICB9KTtcbn1cblxuLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCBmdWxmaWxscyBpZmYgdGhpcyBhcHAgaWQgaXMgdmFsaWQuXG5mdW5jdGlvbiB2YWxpZGF0ZUFwcElkKCkge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZU11bHRpcGxlQ29uZmlndXJhdGlvbnMoYXV0aERhdGEsIG9wdGlvbnMpIHtcbiAgaWYgKEFycmF5LmlzQXJyYXkob3B0aW9ucykpIHtcbiAgICBjb25zdCBjb25zdW1lcl9rZXkgPSBhdXRoRGF0YS5jb25zdW1lcl9rZXk7XG4gICAgaWYgKCFjb25zdW1lcl9rZXkpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgJ1R3aXR0ZXIgYXV0aCBpcyBpbnZhbGlkIGZvciB0aGlzIHVzZXIuJ1xuICAgICAgKTtcbiAgICB9XG4gICAgb3B0aW9ucyA9IG9wdGlvbnMuZmlsdGVyKG9wdGlvbiA9PiB7XG4gICAgICByZXR1cm4gb3B0aW9uLmNvbnN1bWVyX2tleSA9PSBjb25zdW1lcl9rZXk7XG4gICAgfSk7XG5cbiAgICBpZiAob3B0aW9ucy5sZW5ndGggPT0gMCkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAnVHdpdHRlciBhdXRoIGlzIGludmFsaWQgZm9yIHRoaXMgdXNlci4nXG4gICAgICApO1xuICAgIH1cbiAgICBvcHRpb25zID0gb3B0aW9uc1swXTtcbiAgfVxuICByZXR1cm4gb3B0aW9ucztcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIHZhbGlkYXRlQXBwSWQsXG4gIHZhbGlkYXRlQXV0aERhdGEsXG4gIGhhbmRsZU11bHRpcGxlQ29uZmlndXJhdGlvbnMsXG59O1xuIl19
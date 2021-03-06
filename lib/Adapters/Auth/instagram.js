"use strict";

// Helper functions for accessing the instagram API.
var Parse = require('parse/node').Parse;

const httpsRequest = require('./httpsRequest');

const defaultURL = 'https://api.instagram.com/v1/'; // Returns a promise that fulfills iff this user id is valid.

function validateAuthData(authData) {
  const apiURL = authData.apiURL || defaultURL;
  const path = `${apiURL}users/self/?access_token=${authData.access_token}`;
  return httpsRequest.get(path).then(response => {
    if (response && response.data && response.data.id == authData.id) {
      return;
    }

    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Instagram auth is invalid for this user.');
  });
} // Returns a promise that fulfills iff this app id is valid.


function validateAppId() {
  return Promise.resolve();
}

module.exports = {
  validateAppId,
  validateAuthData
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9BdXRoL2luc3RhZ3JhbS5qcyJdLCJuYW1lcyI6WyJQYXJzZSIsInJlcXVpcmUiLCJodHRwc1JlcXVlc3QiLCJkZWZhdWx0VVJMIiwidmFsaWRhdGVBdXRoRGF0YSIsImF1dGhEYXRhIiwiYXBpVVJMIiwicGF0aCIsImFjY2Vzc190b2tlbiIsImdldCIsInRoZW4iLCJyZXNwb25zZSIsImRhdGEiLCJpZCIsIkVycm9yIiwiT0JKRUNUX05PVF9GT1VORCIsInZhbGlkYXRlQXBwSWQiLCJQcm9taXNlIiwicmVzb2x2ZSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUE7QUFDQSxJQUFJQSxLQUFLLEdBQUdDLE9BQU8sQ0FBQyxZQUFELENBQVAsQ0FBc0JELEtBQWxDOztBQUNBLE1BQU1FLFlBQVksR0FBR0QsT0FBTyxDQUFDLGdCQUFELENBQTVCOztBQUNBLE1BQU1FLFVBQVUsR0FBRywrQkFBbkIsQyxDQUVBOztBQUNBLFNBQVNDLGdCQUFULENBQTBCQyxRQUExQixFQUFvQztBQUNsQyxRQUFNQyxNQUFNLEdBQUdELFFBQVEsQ0FBQ0MsTUFBVCxJQUFtQkgsVUFBbEM7QUFDQSxRQUFNSSxJQUFJLEdBQUksR0FBRUQsTUFBTyw0QkFBMkJELFFBQVEsQ0FBQ0csWUFBYSxFQUF4RTtBQUNBLFNBQU9OLFlBQVksQ0FBQ08sR0FBYixDQUFpQkYsSUFBakIsRUFBdUJHLElBQXZCLENBQTRCQyxRQUFRLElBQUk7QUFDN0MsUUFBSUEsUUFBUSxJQUFJQSxRQUFRLENBQUNDLElBQXJCLElBQTZCRCxRQUFRLENBQUNDLElBQVQsQ0FBY0MsRUFBZCxJQUFvQlIsUUFBUSxDQUFDUSxFQUE5RCxFQUFrRTtBQUNoRTtBQUNEOztBQUNELFVBQU0sSUFBSWIsS0FBSyxDQUFDYyxLQUFWLENBQ0pkLEtBQUssQ0FBQ2MsS0FBTixDQUFZQyxnQkFEUixFQUVKLDBDQUZJLENBQU47QUFJRCxHQVJNLENBQVA7QUFTRCxDLENBRUQ7OztBQUNBLFNBQVNDLGFBQVQsR0FBeUI7QUFDdkIsU0FBT0MsT0FBTyxDQUFDQyxPQUFSLEVBQVA7QUFDRDs7QUFFREMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCO0FBQ2ZKLEVBQUFBLGFBRGU7QUFFZlosRUFBQUE7QUFGZSxDQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIi8vIEhlbHBlciBmdW5jdGlvbnMgZm9yIGFjY2Vzc2luZyB0aGUgaW5zdGFncmFtIEFQSS5cbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKS5QYXJzZTtcbmNvbnN0IGh0dHBzUmVxdWVzdCA9IHJlcXVpcmUoJy4vaHR0cHNSZXF1ZXN0Jyk7XG5jb25zdCBkZWZhdWx0VVJMID0gJ2h0dHBzOi8vYXBpLmluc3RhZ3JhbS5jb20vdjEvJztcblxuLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCBmdWxmaWxscyBpZmYgdGhpcyB1c2VyIGlkIGlzIHZhbGlkLlxuZnVuY3Rpb24gdmFsaWRhdGVBdXRoRGF0YShhdXRoRGF0YSkge1xuICBjb25zdCBhcGlVUkwgPSBhdXRoRGF0YS5hcGlVUkwgfHwgZGVmYXVsdFVSTDtcbiAgY29uc3QgcGF0aCA9IGAke2FwaVVSTH11c2Vycy9zZWxmLz9hY2Nlc3NfdG9rZW49JHthdXRoRGF0YS5hY2Nlc3NfdG9rZW59YDtcbiAgcmV0dXJuIGh0dHBzUmVxdWVzdC5nZXQocGF0aCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgaWYgKHJlc3BvbnNlICYmIHJlc3BvbnNlLmRhdGEgJiYgcmVzcG9uc2UuZGF0YS5pZCA9PSBhdXRoRGF0YS5pZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgJ0luc3RhZ3JhbSBhdXRoIGlzIGludmFsaWQgZm9yIHRoaXMgdXNlci4nXG4gICAgKTtcbiAgfSk7XG59XG5cbi8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgZnVsZmlsbHMgaWZmIHRoaXMgYXBwIGlkIGlzIHZhbGlkLlxuZnVuY3Rpb24gdmFsaWRhdGVBcHBJZCgpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgdmFsaWRhdGVBcHBJZCxcbiAgdmFsaWRhdGVBdXRoRGF0YSxcbn07XG4iXX0=
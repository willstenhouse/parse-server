"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.Config = void 0;

var _cache = _interopRequireDefault(require("./cache"));

var _SchemaCache = _interopRequireDefault(require("./Controllers/SchemaCache"));

var _DatabaseController = _interopRequireDefault(require("./Controllers/DatabaseController"));

var _net = _interopRequireDefault(require("net"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// A Config object provides information about how a specific app is
// configured.
// mount is the URL for the root of the API; includes http, domain, etc.
function removeTrailingSlash(str) {
  if (!str) {
    return str;
  }

  if (str.endsWith('/')) {
    str = str.substr(0, str.length - 1);
  }

  return str;
}

class Config {
  static get(applicationId, mount) {
    const cacheInfo = _cache.default.get(applicationId);

    if (!cacheInfo) {
      return;
    }

    const config = new Config();
    config.applicationId = applicationId;
    Object.keys(cacheInfo).forEach(key => {
      if (key == 'databaseController') {
        const schemaCache = new _SchemaCache.default(cacheInfo.cacheController, cacheInfo.schemaCacheTTL, cacheInfo.enableSingleSchemaCache);
        config.database = new _DatabaseController.default(cacheInfo.databaseController.adapter, schemaCache);
      } else {
        config[key] = cacheInfo[key];
      }
    });
    config.mount = removeTrailingSlash(mount);
    config.generateSessionExpiresAt = config.generateSessionExpiresAt.bind(config);
    config.generateEmailVerifyTokenExpiresAt = config.generateEmailVerifyTokenExpiresAt.bind(config);
    return config;
  }

  static put(serverConfiguration) {
    Config.validate(serverConfiguration);

    _cache.default.put(serverConfiguration.appId, serverConfiguration);

    Config.setupPasswordValidator(serverConfiguration.passwordPolicy);
    return serverConfiguration;
  }

  static validate({
    verifyUserEmails,
    userController,
    appName,
    publicServerURL,
    revokeSessionOnPasswordReset,
    expireInactiveSessions,
    sessionLength,
    maxLimit,
    emailVerifyTokenValidityDuration,
    accountLockout,
    passwordPolicy,
    masterKeyIps,
    masterKey,
    readOnlyMasterKey,
    allowHeaders
  }) {
    if (masterKey === readOnlyMasterKey) {
      throw new Error('masterKey and readOnlyMasterKey should be different');
    }

    const emailAdapter = userController.adapter;

    if (verifyUserEmails) {
      this.validateEmailConfiguration({
        emailAdapter,
        appName,
        publicServerURL,
        emailVerifyTokenValidityDuration
      });
    }

    this.validateAccountLockoutPolicy(accountLockout);
    this.validatePasswordPolicy(passwordPolicy);

    if (typeof revokeSessionOnPasswordReset !== 'boolean') {
      throw 'revokeSessionOnPasswordReset must be a boolean value';
    }

    if (publicServerURL) {
      if (!publicServerURL.startsWith('http://') && !publicServerURL.startsWith('https://')) {
        throw 'publicServerURL should be a valid HTTPS URL starting with https://';
      }
    }

    this.validateSessionConfiguration(sessionLength, expireInactiveSessions);
    this.validateMasterKeyIps(masterKeyIps);
    this.validateMaxLimit(maxLimit);
    this.validateAllowHeaders(allowHeaders);
  }

  static validateAccountLockoutPolicy(accountLockout) {
    if (accountLockout) {
      if (typeof accountLockout.duration !== 'number' || accountLockout.duration <= 0 || accountLockout.duration > 99999) {
        throw 'Account lockout duration should be greater than 0 and less than 100000';
      }

      if (!Number.isInteger(accountLockout.threshold) || accountLockout.threshold < 1 || accountLockout.threshold > 999) {
        throw 'Account lockout threshold should be an integer greater than 0 and less than 1000';
      }
    }
  }

  static validatePasswordPolicy(passwordPolicy) {
    if (passwordPolicy) {
      if (passwordPolicy.maxPasswordAge !== undefined && (typeof passwordPolicy.maxPasswordAge !== 'number' || passwordPolicy.maxPasswordAge < 0)) {
        throw 'passwordPolicy.maxPasswordAge must be a positive number';
      }

      if (passwordPolicy.resetTokenValidityDuration !== undefined && (typeof passwordPolicy.resetTokenValidityDuration !== 'number' || passwordPolicy.resetTokenValidityDuration <= 0)) {
        throw 'passwordPolicy.resetTokenValidityDuration must be a positive number';
      }

      if (passwordPolicy.validatorPattern) {
        if (typeof passwordPolicy.validatorPattern === 'string') {
          passwordPolicy.validatorPattern = new RegExp(passwordPolicy.validatorPattern);
        } else if (!(passwordPolicy.validatorPattern instanceof RegExp)) {
          throw 'passwordPolicy.validatorPattern must be a regex string or RegExp object.';
        }
      }

      if (passwordPolicy.validatorCallback && typeof passwordPolicy.validatorCallback !== 'function') {
        throw 'passwordPolicy.validatorCallback must be a function.';
      }

      if (passwordPolicy.doNotAllowUsername && typeof passwordPolicy.doNotAllowUsername !== 'boolean') {
        throw 'passwordPolicy.doNotAllowUsername must be a boolean value.';
      }

      if (passwordPolicy.maxPasswordHistory && (!Number.isInteger(passwordPolicy.maxPasswordHistory) || passwordPolicy.maxPasswordHistory <= 0 || passwordPolicy.maxPasswordHistory > 20)) {
        throw 'passwordPolicy.maxPasswordHistory must be an integer ranging 0 - 20';
      }
    }
  } // if the passwordPolicy.validatorPattern is configured then setup a callback to process the pattern


  static setupPasswordValidator(passwordPolicy) {
    if (passwordPolicy && passwordPolicy.validatorPattern) {
      passwordPolicy.patternValidator = value => {
        return passwordPolicy.validatorPattern.test(value);
      };
    }
  }

  static validateEmailConfiguration({
    emailAdapter,
    appName,
    publicServerURL,
    emailVerifyTokenValidityDuration
  }) {
    if (!emailAdapter) {
      throw 'An emailAdapter is required for e-mail verification and password resets.';
    }

    if (typeof appName !== 'string') {
      throw 'An app name is required for e-mail verification and password resets.';
    }

    if (typeof publicServerURL !== 'string') {
      throw 'A public server url is required for e-mail verification and password resets.';
    }

    if (emailVerifyTokenValidityDuration) {
      if (isNaN(emailVerifyTokenValidityDuration)) {
        throw 'Email verify token validity duration must be a valid number.';
      } else if (emailVerifyTokenValidityDuration <= 0) {
        throw 'Email verify token validity duration must be a value greater than 0.';
      }
    }
  }

  static validateMasterKeyIps(masterKeyIps) {
    for (const ip of masterKeyIps) {
      if (!_net.default.isIP(ip)) {
        throw `Invalid ip in masterKeyIps: ${ip}`;
      }
    }
  }

  get mount() {
    var mount = this._mount;

    if (this.publicServerURL) {
      mount = this.publicServerURL;
    }

    return mount;
  }

  set mount(newValue) {
    this._mount = newValue;
  }

  static validateSessionConfiguration(sessionLength, expireInactiveSessions) {
    if (expireInactiveSessions) {
      if (isNaN(sessionLength)) {
        throw 'Session length must be a valid number.';
      } else if (sessionLength <= 0) {
        throw 'Session length must be a value greater than 0.';
      }
    }
  }

  static validateMaxLimit(maxLimit) {
    if (maxLimit <= 0) {
      throw 'Max limit must be a value greater than 0.';
    }
  }

  static validateAllowHeaders(allowHeaders) {
    if (![null, undefined].includes(allowHeaders)) {
      if (Array.isArray(allowHeaders)) {
        allowHeaders.forEach(header => {
          if (typeof header !== 'string') {
            throw 'Allow headers must only contain strings';
          } else if (!header.trim().length) {
            throw 'Allow headers must not contain empty strings';
          }
        });
      } else {
        throw 'Allow headers must be an array';
      }
    }
  }

  generateEmailVerifyTokenExpiresAt() {
    if (!this.verifyUserEmails || !this.emailVerifyTokenValidityDuration) {
      return undefined;
    }

    var now = new Date();
    return new Date(now.getTime() + this.emailVerifyTokenValidityDuration * 1000);
  }

  generatePasswordResetTokenExpiresAt() {
    if (!this.passwordPolicy || !this.passwordPolicy.resetTokenValidityDuration) {
      return undefined;
    }

    const now = new Date();
    return new Date(now.getTime() + this.passwordPolicy.resetTokenValidityDuration * 1000);
  }

  generateSessionExpiresAt() {
    if (!this.expireInactiveSessions) {
      return undefined;
    }

    var now = new Date();
    return new Date(now.getTime() + this.sessionLength * 1000);
  }

  get invalidLinkURL() {
    return this.customPages.invalidLink || `${this.publicServerURL}/apps/invalid_link.html`;
  }

  get invalidVerificationLinkURL() {
    return this.customPages.invalidVerificationLink || `${this.publicServerURL}/apps/invalid_verification_link.html`;
  }

  get linkSendSuccessURL() {
    return this.customPages.linkSendSuccess || `${this.publicServerURL}/apps/link_send_success.html`;
  }

  get linkSendFailURL() {
    return this.customPages.linkSendFail || `${this.publicServerURL}/apps/link_send_fail.html`;
  }

  get verifyEmailSuccessURL() {
    return this.customPages.verifyEmailSuccess || `${this.publicServerURL}/apps/verify_email_success.html`;
  }

  get choosePasswordURL() {
    return this.customPages.choosePassword || `${this.publicServerURL}/apps/choose_password`;
  }

  get requestResetPasswordURL() {
    return `${this.publicServerURL}/apps/${this.applicationId}/request_password_reset`;
  }

  get passwordResetSuccessURL() {
    return this.customPages.passwordResetSuccess || `${this.publicServerURL}/apps/password_reset_success.html`;
  }

  get parseFrameURL() {
    return this.customPages.parseFrameURL;
  }

  get verifyEmailURL() {
    return `${this.publicServerURL}/apps/${this.applicationId}/verify_email`;
  }

}

exports.Config = Config;
var _default = Config;
exports.default = _default;
module.exports = Config;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9Db25maWcuanMiXSwibmFtZXMiOlsicmVtb3ZlVHJhaWxpbmdTbGFzaCIsInN0ciIsImVuZHNXaXRoIiwic3Vic3RyIiwibGVuZ3RoIiwiQ29uZmlnIiwiZ2V0IiwiYXBwbGljYXRpb25JZCIsIm1vdW50IiwiY2FjaGVJbmZvIiwiQXBwQ2FjaGUiLCJjb25maWciLCJPYmplY3QiLCJrZXlzIiwiZm9yRWFjaCIsImtleSIsInNjaGVtYUNhY2hlIiwiU2NoZW1hQ2FjaGUiLCJjYWNoZUNvbnRyb2xsZXIiLCJzY2hlbWFDYWNoZVRUTCIsImVuYWJsZVNpbmdsZVNjaGVtYUNhY2hlIiwiZGF0YWJhc2UiLCJEYXRhYmFzZUNvbnRyb2xsZXIiLCJkYXRhYmFzZUNvbnRyb2xsZXIiLCJhZGFwdGVyIiwiZ2VuZXJhdGVTZXNzaW9uRXhwaXJlc0F0IiwiYmluZCIsImdlbmVyYXRlRW1haWxWZXJpZnlUb2tlbkV4cGlyZXNBdCIsInB1dCIsInNlcnZlckNvbmZpZ3VyYXRpb24iLCJ2YWxpZGF0ZSIsImFwcElkIiwic2V0dXBQYXNzd29yZFZhbGlkYXRvciIsInBhc3N3b3JkUG9saWN5IiwidmVyaWZ5VXNlckVtYWlscyIsInVzZXJDb250cm9sbGVyIiwiYXBwTmFtZSIsInB1YmxpY1NlcnZlclVSTCIsInJldm9rZVNlc3Npb25PblBhc3N3b3JkUmVzZXQiLCJleHBpcmVJbmFjdGl2ZVNlc3Npb25zIiwic2Vzc2lvbkxlbmd0aCIsIm1heExpbWl0IiwiZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24iLCJhY2NvdW50TG9ja291dCIsIm1hc3RlcktleUlwcyIsIm1hc3RlcktleSIsInJlYWRPbmx5TWFzdGVyS2V5IiwiYWxsb3dIZWFkZXJzIiwiRXJyb3IiLCJlbWFpbEFkYXB0ZXIiLCJ2YWxpZGF0ZUVtYWlsQ29uZmlndXJhdGlvbiIsInZhbGlkYXRlQWNjb3VudExvY2tvdXRQb2xpY3kiLCJ2YWxpZGF0ZVBhc3N3b3JkUG9saWN5Iiwic3RhcnRzV2l0aCIsInZhbGlkYXRlU2Vzc2lvbkNvbmZpZ3VyYXRpb24iLCJ2YWxpZGF0ZU1hc3RlcktleUlwcyIsInZhbGlkYXRlTWF4TGltaXQiLCJ2YWxpZGF0ZUFsbG93SGVhZGVycyIsImR1cmF0aW9uIiwiTnVtYmVyIiwiaXNJbnRlZ2VyIiwidGhyZXNob2xkIiwibWF4UGFzc3dvcmRBZ2UiLCJ1bmRlZmluZWQiLCJyZXNldFRva2VuVmFsaWRpdHlEdXJhdGlvbiIsInZhbGlkYXRvclBhdHRlcm4iLCJSZWdFeHAiLCJ2YWxpZGF0b3JDYWxsYmFjayIsImRvTm90QWxsb3dVc2VybmFtZSIsIm1heFBhc3N3b3JkSGlzdG9yeSIsInBhdHRlcm5WYWxpZGF0b3IiLCJ2YWx1ZSIsInRlc3QiLCJpc05hTiIsImlwIiwibmV0IiwiaXNJUCIsIl9tb3VudCIsIm5ld1ZhbHVlIiwiaW5jbHVkZXMiLCJBcnJheSIsImlzQXJyYXkiLCJoZWFkZXIiLCJ0cmltIiwibm93IiwiRGF0ZSIsImdldFRpbWUiLCJnZW5lcmF0ZVBhc3N3b3JkUmVzZXRUb2tlbkV4cGlyZXNBdCIsImludmFsaWRMaW5rVVJMIiwiY3VzdG9tUGFnZXMiLCJpbnZhbGlkTGluayIsImludmFsaWRWZXJpZmljYXRpb25MaW5rVVJMIiwiaW52YWxpZFZlcmlmaWNhdGlvbkxpbmsiLCJsaW5rU2VuZFN1Y2Nlc3NVUkwiLCJsaW5rU2VuZFN1Y2Nlc3MiLCJsaW5rU2VuZEZhaWxVUkwiLCJsaW5rU2VuZEZhaWwiLCJ2ZXJpZnlFbWFpbFN1Y2Nlc3NVUkwiLCJ2ZXJpZnlFbWFpbFN1Y2Nlc3MiLCJjaG9vc2VQYXNzd29yZFVSTCIsImNob29zZVBhc3N3b3JkIiwicmVxdWVzdFJlc2V0UGFzc3dvcmRVUkwiLCJwYXNzd29yZFJlc2V0U3VjY2Vzc1VSTCIsInBhc3N3b3JkUmVzZXRTdWNjZXNzIiwicGFyc2VGcmFtZVVSTCIsInZlcmlmeUVtYWlsVVJMIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQUlBOztBQUNBOztBQUNBOztB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LCJzb3VyY2VzQ29udGVudCI6WyIvLyBBIENvbmZpZyBvYmplY3QgcHJvdmlkZXMgaW5mb3JtYXRpb24gYWJvdXQgaG93IGEgc3BlY2lmaWMgYXBwIGlzXG4vLyBjb25maWd1cmVkLlxuLy8gbW91bnQgaXMgdGhlIFVSTCBmb3IgdGhlIHJvb3Qgb2YgdGhlIEFQSTsgaW5jbHVkZXMgaHR0cCwgZG9tYWluLCBldGMuXG5cbmltcG9ydCBBcHBDYWNoZSBmcm9tICcuL2NhY2hlJztcbmltcG9ydCBTY2hlbWFDYWNoZSBmcm9tICcuL0NvbnRyb2xsZXJzL1NjaGVtYUNhY2hlJztcbmltcG9ydCBEYXRhYmFzZUNvbnRyb2xsZXIgZnJvbSAnLi9Db250cm9sbGVycy9EYXRhYmFzZUNvbnRyb2xsZXInO1xuaW1wb3J0IG5ldCBmcm9tICduZXQnO1xuXG5mdW5jdGlvbiByZW1vdmVUcmFpbGluZ1NsYXNoKHN0cikge1xuICBpZiAoIXN0cikge1xuICAgIHJldHVybiBzdHI7XG4gIH1cbiAgaWYgKHN0ci5lbmRzV2l0aCgnLycpKSB7XG4gICAgc3RyID0gc3RyLnN1YnN0cigwLCBzdHIubGVuZ3RoIC0gMSk7XG4gIH1cbiAgcmV0dXJuIHN0cjtcbn1cblxuZXhwb3J0IGNsYXNzIENvbmZpZyB7XG4gIHN0YXRpYyBnZXQoYXBwbGljYXRpb25JZDogc3RyaW5nLCBtb3VudDogc3RyaW5nKSB7XG4gICAgY29uc3QgY2FjaGVJbmZvID0gQXBwQ2FjaGUuZ2V0KGFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghY2FjaGVJbmZvKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGNvbmZpZyA9IG5ldyBDb25maWcoKTtcbiAgICBjb25maWcuYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQ7XG4gICAgT2JqZWN0LmtleXMoY2FjaGVJbmZvKS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICBpZiAoa2V5ID09ICdkYXRhYmFzZUNvbnRyb2xsZXInKSB7XG4gICAgICAgIGNvbnN0IHNjaGVtYUNhY2hlID0gbmV3IFNjaGVtYUNhY2hlKFxuICAgICAgICAgIGNhY2hlSW5mby5jYWNoZUNvbnRyb2xsZXIsXG4gICAgICAgICAgY2FjaGVJbmZvLnNjaGVtYUNhY2hlVFRMLFxuICAgICAgICAgIGNhY2hlSW5mby5lbmFibGVTaW5nbGVTY2hlbWFDYWNoZVxuICAgICAgICApO1xuICAgICAgICBjb25maWcuZGF0YWJhc2UgPSBuZXcgRGF0YWJhc2VDb250cm9sbGVyKFxuICAgICAgICAgIGNhY2hlSW5mby5kYXRhYmFzZUNvbnRyb2xsZXIuYWRhcHRlcixcbiAgICAgICAgICBzY2hlbWFDYWNoZVxuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uZmlnW2tleV0gPSBjYWNoZUluZm9ba2V5XTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjb25maWcubW91bnQgPSByZW1vdmVUcmFpbGluZ1NsYXNoKG1vdW50KTtcbiAgICBjb25maWcuZ2VuZXJhdGVTZXNzaW9uRXhwaXJlc0F0ID0gY29uZmlnLmdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdC5iaW5kKFxuICAgICAgY29uZmlnXG4gICAgKTtcbiAgICBjb25maWcuZ2VuZXJhdGVFbWFpbFZlcmlmeVRva2VuRXhwaXJlc0F0ID0gY29uZmlnLmdlbmVyYXRlRW1haWxWZXJpZnlUb2tlbkV4cGlyZXNBdC5iaW5kKFxuICAgICAgY29uZmlnXG4gICAgKTtcbiAgICByZXR1cm4gY29uZmlnO1xuICB9XG5cbiAgc3RhdGljIHB1dChzZXJ2ZXJDb25maWd1cmF0aW9uKSB7XG4gICAgQ29uZmlnLnZhbGlkYXRlKHNlcnZlckNvbmZpZ3VyYXRpb24pO1xuICAgIEFwcENhY2hlLnB1dChzZXJ2ZXJDb25maWd1cmF0aW9uLmFwcElkLCBzZXJ2ZXJDb25maWd1cmF0aW9uKTtcbiAgICBDb25maWcuc2V0dXBQYXNzd29yZFZhbGlkYXRvcihzZXJ2ZXJDb25maWd1cmF0aW9uLnBhc3N3b3JkUG9saWN5KTtcbiAgICByZXR1cm4gc2VydmVyQ29uZmlndXJhdGlvbjtcbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZSh7XG4gICAgdmVyaWZ5VXNlckVtYWlscyxcbiAgICB1c2VyQ29udHJvbGxlcixcbiAgICBhcHBOYW1lLFxuICAgIHB1YmxpY1NlcnZlclVSTCxcbiAgICByZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0LFxuICAgIGV4cGlyZUluYWN0aXZlU2Vzc2lvbnMsXG4gICAgc2Vzc2lvbkxlbmd0aCxcbiAgICBtYXhMaW1pdCxcbiAgICBlbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbixcbiAgICBhY2NvdW50TG9ja291dCxcbiAgICBwYXNzd29yZFBvbGljeSxcbiAgICBtYXN0ZXJLZXlJcHMsXG4gICAgbWFzdGVyS2V5LFxuICAgIHJlYWRPbmx5TWFzdGVyS2V5LFxuICAgIGFsbG93SGVhZGVycyxcbiAgfSkge1xuICAgIGlmIChtYXN0ZXJLZXkgPT09IHJlYWRPbmx5TWFzdGVyS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ21hc3RlcktleSBhbmQgcmVhZE9ubHlNYXN0ZXJLZXkgc2hvdWxkIGJlIGRpZmZlcmVudCcpO1xuICAgIH1cblxuICAgIGNvbnN0IGVtYWlsQWRhcHRlciA9IHVzZXJDb250cm9sbGVyLmFkYXB0ZXI7XG4gICAgaWYgKHZlcmlmeVVzZXJFbWFpbHMpIHtcbiAgICAgIHRoaXMudmFsaWRhdGVFbWFpbENvbmZpZ3VyYXRpb24oe1xuICAgICAgICBlbWFpbEFkYXB0ZXIsXG4gICAgICAgIGFwcE5hbWUsXG4gICAgICAgIHB1YmxpY1NlcnZlclVSTCxcbiAgICAgICAgZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24sXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICB0aGlzLnZhbGlkYXRlQWNjb3VudExvY2tvdXRQb2xpY3koYWNjb3VudExvY2tvdXQpO1xuXG4gICAgdGhpcy52YWxpZGF0ZVBhc3N3b3JkUG9saWN5KHBhc3N3b3JkUG9saWN5KTtcblxuICAgIGlmICh0eXBlb2YgcmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAncmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZSc7XG4gICAgfVxuXG4gICAgaWYgKHB1YmxpY1NlcnZlclVSTCkge1xuICAgICAgaWYgKFxuICAgICAgICAhcHVibGljU2VydmVyVVJMLnN0YXJ0c1dpdGgoJ2h0dHA6Ly8nKSAmJlxuICAgICAgICAhcHVibGljU2VydmVyVVJMLnN0YXJ0c1dpdGgoJ2h0dHBzOi8vJylcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncHVibGljU2VydmVyVVJMIHNob3VsZCBiZSBhIHZhbGlkIEhUVFBTIFVSTCBzdGFydGluZyB3aXRoIGh0dHBzOi8vJztcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLnZhbGlkYXRlU2Vzc2lvbkNvbmZpZ3VyYXRpb24oc2Vzc2lvbkxlbmd0aCwgZXhwaXJlSW5hY3RpdmVTZXNzaW9ucyk7XG5cbiAgICB0aGlzLnZhbGlkYXRlTWFzdGVyS2V5SXBzKG1hc3RlcktleUlwcyk7XG5cbiAgICB0aGlzLnZhbGlkYXRlTWF4TGltaXQobWF4TGltaXQpO1xuXG4gICAgdGhpcy52YWxpZGF0ZUFsbG93SGVhZGVycyhhbGxvd0hlYWRlcnMpO1xuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlQWNjb3VudExvY2tvdXRQb2xpY3koYWNjb3VudExvY2tvdXQpIHtcbiAgICBpZiAoYWNjb3VudExvY2tvdXQpIHtcbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIGFjY291bnRMb2Nrb3V0LmR1cmF0aW9uICE9PSAnbnVtYmVyJyB8fFxuICAgICAgICBhY2NvdW50TG9ja291dC5kdXJhdGlvbiA8PSAwIHx8XG4gICAgICAgIGFjY291bnRMb2Nrb3V0LmR1cmF0aW9uID4gOTk5OTlcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAnQWNjb3VudCBsb2Nrb3V0IGR1cmF0aW9uIHNob3VsZCBiZSBncmVhdGVyIHRoYW4gMCBhbmQgbGVzcyB0aGFuIDEwMDAwMCc7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgIU51bWJlci5pc0ludGVnZXIoYWNjb3VudExvY2tvdXQudGhyZXNob2xkKSB8fFxuICAgICAgICBhY2NvdW50TG9ja291dC50aHJlc2hvbGQgPCAxIHx8XG4gICAgICAgIGFjY291bnRMb2Nrb3V0LnRocmVzaG9sZCA+IDk5OVxuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdBY2NvdW50IGxvY2tvdXQgdGhyZXNob2xkIHNob3VsZCBiZSBhbiBpbnRlZ2VyIGdyZWF0ZXIgdGhhbiAwIGFuZCBsZXNzIHRoYW4gMTAwMCc7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlUGFzc3dvcmRQb2xpY3kocGFzc3dvcmRQb2xpY3kpIHtcbiAgICBpZiAocGFzc3dvcmRQb2xpY3kpIHtcbiAgICAgIGlmIChcbiAgICAgICAgcGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAodHlwZW9mIHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlICE9PSAnbnVtYmVyJyB8fFxuICAgICAgICAgIHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlIDwgMClcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UgbXVzdCBiZSBhIHBvc2l0aXZlIG51bWJlcic7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgcGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb24gIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAodHlwZW9mIHBhc3N3b3JkUG9saWN5LnJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uICE9PSAnbnVtYmVyJyB8fFxuICAgICAgICAgIHBhc3N3b3JkUG9saWN5LnJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uIDw9IDApXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgJ3Bhc3N3b3JkUG9saWN5LnJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uIG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXInO1xuICAgICAgfVxuXG4gICAgICBpZiAocGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yUGF0dGVybikge1xuICAgICAgICBpZiAodHlwZW9mIHBhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4gPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yUGF0dGVybiA9IG5ldyBSZWdFeHAoXG4gICAgICAgICAgICBwYXNzd29yZFBvbGljeS52YWxpZGF0b3JQYXR0ZXJuXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIGlmICghKHBhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4gaW5zdGFuY2VvZiBSZWdFeHApKSB7XG4gICAgICAgICAgdGhyb3cgJ3Bhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4gbXVzdCBiZSBhIHJlZ2V4IHN0cmluZyBvciBSZWdFeHAgb2JqZWN0Lic7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayAmJlxuICAgICAgICB0eXBlb2YgcGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sgIT09ICdmdW5jdGlvbidcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sgbXVzdCBiZSBhIGZ1bmN0aW9uLic7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgcGFzc3dvcmRQb2xpY3kuZG9Ob3RBbGxvd1VzZXJuYW1lICYmXG4gICAgICAgIHR5cGVvZiBwYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgIT09ICdib29sZWFuJ1xuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdwYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgbXVzdCBiZSBhIGJvb2xlYW4gdmFsdWUuJztcbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgJiZcbiAgICAgICAgKCFOdW1iZXIuaXNJbnRlZ2VyKHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSkgfHxcbiAgICAgICAgICBwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgPD0gMCB8fFxuICAgICAgICAgIHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSA+IDIwKVxuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgbXVzdCBiZSBhbiBpbnRlZ2VyIHJhbmdpbmcgMCAtIDIwJztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBpZiB0aGUgcGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yUGF0dGVybiBpcyBjb25maWd1cmVkIHRoZW4gc2V0dXAgYSBjYWxsYmFjayB0byBwcm9jZXNzIHRoZSBwYXR0ZXJuXG4gIHN0YXRpYyBzZXR1cFBhc3N3b3JkVmFsaWRhdG9yKHBhc3N3b3JkUG9saWN5KSB7XG4gICAgaWYgKHBhc3N3b3JkUG9saWN5ICYmIHBhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4pIHtcbiAgICAgIHBhc3N3b3JkUG9saWN5LnBhdHRlcm5WYWxpZGF0b3IgPSB2YWx1ZSA9PiB7XG4gICAgICAgIHJldHVybiBwYXNzd29yZFBvbGljeS52YWxpZGF0b3JQYXR0ZXJuLnRlc3QodmFsdWUpO1xuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVFbWFpbENvbmZpZ3VyYXRpb24oe1xuICAgIGVtYWlsQWRhcHRlcixcbiAgICBhcHBOYW1lLFxuICAgIHB1YmxpY1NlcnZlclVSTCxcbiAgICBlbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbixcbiAgfSkge1xuICAgIGlmICghZW1haWxBZGFwdGVyKSB7XG4gICAgICB0aHJvdyAnQW4gZW1haWxBZGFwdGVyIGlzIHJlcXVpcmVkIGZvciBlLW1haWwgdmVyaWZpY2F0aW9uIGFuZCBwYXNzd29yZCByZXNldHMuJztcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBhcHBOYW1lICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgJ0FuIGFwcCBuYW1lIGlzIHJlcXVpcmVkIGZvciBlLW1haWwgdmVyaWZpY2F0aW9uIGFuZCBwYXNzd29yZCByZXNldHMuJztcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBwdWJsaWNTZXJ2ZXJVUkwgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyAnQSBwdWJsaWMgc2VydmVyIHVybCBpcyByZXF1aXJlZCBmb3IgZS1tYWlsIHZlcmlmaWNhdGlvbiBhbmQgcGFzc3dvcmQgcmVzZXRzLic7XG4gICAgfVxuICAgIGlmIChlbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbikge1xuICAgICAgaWYgKGlzTmFOKGVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uKSkge1xuICAgICAgICB0aHJvdyAnRW1haWwgdmVyaWZ5IHRva2VuIHZhbGlkaXR5IGR1cmF0aW9uIG11c3QgYmUgYSB2YWxpZCBudW1iZXIuJztcbiAgICAgIH0gZWxzZSBpZiAoZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24gPD0gMCkge1xuICAgICAgICB0aHJvdyAnRW1haWwgdmVyaWZ5IHRva2VuIHZhbGlkaXR5IGR1cmF0aW9uIG11c3QgYmUgYSB2YWx1ZSBncmVhdGVyIHRoYW4gMC4nO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZU1hc3RlcktleUlwcyhtYXN0ZXJLZXlJcHMpIHtcbiAgICBmb3IgKGNvbnN0IGlwIG9mIG1hc3RlcktleUlwcykge1xuICAgICAgaWYgKCFuZXQuaXNJUChpcCkpIHtcbiAgICAgICAgdGhyb3cgYEludmFsaWQgaXAgaW4gbWFzdGVyS2V5SXBzOiAke2lwfWA7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vdW50KCkge1xuICAgIHZhciBtb3VudCA9IHRoaXMuX21vdW50O1xuICAgIGlmICh0aGlzLnB1YmxpY1NlcnZlclVSTCkge1xuICAgICAgbW91bnQgPSB0aGlzLnB1YmxpY1NlcnZlclVSTDtcbiAgICB9XG4gICAgcmV0dXJuIG1vdW50O1xuICB9XG5cbiAgc2V0IG1vdW50KG5ld1ZhbHVlKSB7XG4gICAgdGhpcy5fbW91bnQgPSBuZXdWYWx1ZTtcbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZVNlc3Npb25Db25maWd1cmF0aW9uKHNlc3Npb25MZW5ndGgsIGV4cGlyZUluYWN0aXZlU2Vzc2lvbnMpIHtcbiAgICBpZiAoZXhwaXJlSW5hY3RpdmVTZXNzaW9ucykge1xuICAgICAgaWYgKGlzTmFOKHNlc3Npb25MZW5ndGgpKSB7XG4gICAgICAgIHRocm93ICdTZXNzaW9uIGxlbmd0aCBtdXN0IGJlIGEgdmFsaWQgbnVtYmVyLic7XG4gICAgICB9IGVsc2UgaWYgKHNlc3Npb25MZW5ndGggPD0gMCkge1xuICAgICAgICB0aHJvdyAnU2Vzc2lvbiBsZW5ndGggbXVzdCBiZSBhIHZhbHVlIGdyZWF0ZXIgdGhhbiAwLic7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlTWF4TGltaXQobWF4TGltaXQpIHtcbiAgICBpZiAobWF4TGltaXQgPD0gMCkge1xuICAgICAgdGhyb3cgJ01heCBsaW1pdCBtdXN0IGJlIGEgdmFsdWUgZ3JlYXRlciB0aGFuIDAuJztcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVBbGxvd0hlYWRlcnMoYWxsb3dIZWFkZXJzKSB7XG4gICAgaWYgKCFbbnVsbCwgdW5kZWZpbmVkXS5pbmNsdWRlcyhhbGxvd0hlYWRlcnMpKSB7XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShhbGxvd0hlYWRlcnMpKSB7XG4gICAgICAgIGFsbG93SGVhZGVycy5mb3JFYWNoKGhlYWRlciA9PiB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBoZWFkZXIgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyAnQWxsb3cgaGVhZGVycyBtdXN0IG9ubHkgY29udGFpbiBzdHJpbmdzJztcbiAgICAgICAgICB9IGVsc2UgaWYgKCFoZWFkZXIudHJpbSgpLmxlbmd0aCkge1xuICAgICAgICAgICAgdGhyb3cgJ0FsbG93IGhlYWRlcnMgbXVzdCBub3QgY29udGFpbiBlbXB0eSBzdHJpbmdzJztcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgJ0FsbG93IGhlYWRlcnMgbXVzdCBiZSBhbiBhcnJheSc7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZ2VuZXJhdGVFbWFpbFZlcmlmeVRva2VuRXhwaXJlc0F0KCkge1xuICAgIGlmICghdGhpcy52ZXJpZnlVc2VyRW1haWxzIHx8ICF0aGlzLmVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICB2YXIgbm93ID0gbmV3IERhdGUoKTtcbiAgICByZXR1cm4gbmV3IERhdGUoXG4gICAgICBub3cuZ2V0VGltZSgpICsgdGhpcy5lbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbiAqIDEwMDBcbiAgICApO1xuICB9XG5cbiAgZ2VuZXJhdGVQYXNzd29yZFJlc2V0VG9rZW5FeHBpcmVzQXQoKSB7XG4gICAgaWYgKFxuICAgICAgIXRoaXMucGFzc3dvcmRQb2xpY3kgfHxcbiAgICAgICF0aGlzLnBhc3N3b3JkUG9saWN5LnJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uXG4gICAgKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuICAgIHJldHVybiBuZXcgRGF0ZShcbiAgICAgIG5vdy5nZXRUaW1lKCkgKyB0aGlzLnBhc3N3b3JkUG9saWN5LnJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uICogMTAwMFxuICAgICk7XG4gIH1cblxuICBnZW5lcmF0ZVNlc3Npb25FeHBpcmVzQXQoKSB7XG4gICAgaWYgKCF0aGlzLmV4cGlyZUluYWN0aXZlU2Vzc2lvbnMpIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIHZhciBub3cgPSBuZXcgRGF0ZSgpO1xuICAgIHJldHVybiBuZXcgRGF0ZShub3cuZ2V0VGltZSgpICsgdGhpcy5zZXNzaW9uTGVuZ3RoICogMTAwMCk7XG4gIH1cblxuICBnZXQgaW52YWxpZExpbmtVUkwoKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIHRoaXMuY3VzdG9tUGFnZXMuaW52YWxpZExpbmsgfHxcbiAgICAgIGAke3RoaXMucHVibGljU2VydmVyVVJMfS9hcHBzL2ludmFsaWRfbGluay5odG1sYFxuICAgICk7XG4gIH1cblxuICBnZXQgaW52YWxpZFZlcmlmaWNhdGlvbkxpbmtVUkwoKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIHRoaXMuY3VzdG9tUGFnZXMuaW52YWxpZFZlcmlmaWNhdGlvbkxpbmsgfHxcbiAgICAgIGAke3RoaXMucHVibGljU2VydmVyVVJMfS9hcHBzL2ludmFsaWRfdmVyaWZpY2F0aW9uX2xpbmsuaHRtbGBcbiAgICApO1xuICB9XG5cbiAgZ2V0IGxpbmtTZW5kU3VjY2Vzc1VSTCgpIHtcbiAgICByZXR1cm4gKFxuICAgICAgdGhpcy5jdXN0b21QYWdlcy5saW5rU2VuZFN1Y2Nlc3MgfHxcbiAgICAgIGAke3RoaXMucHVibGljU2VydmVyVVJMfS9hcHBzL2xpbmtfc2VuZF9zdWNjZXNzLmh0bWxgXG4gICAgKTtcbiAgfVxuXG4gIGdldCBsaW5rU2VuZEZhaWxVUkwoKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIHRoaXMuY3VzdG9tUGFnZXMubGlua1NlbmRGYWlsIHx8XG4gICAgICBgJHt0aGlzLnB1YmxpY1NlcnZlclVSTH0vYXBwcy9saW5rX3NlbmRfZmFpbC5odG1sYFxuICAgICk7XG4gIH1cblxuICBnZXQgdmVyaWZ5RW1haWxTdWNjZXNzVVJMKCkge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLmN1c3RvbVBhZ2VzLnZlcmlmeUVtYWlsU3VjY2VzcyB8fFxuICAgICAgYCR7dGhpcy5wdWJsaWNTZXJ2ZXJVUkx9L2FwcHMvdmVyaWZ5X2VtYWlsX3N1Y2Nlc3MuaHRtbGBcbiAgICApO1xuICB9XG5cbiAgZ2V0IGNob29zZVBhc3N3b3JkVVJMKCkge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLmN1c3RvbVBhZ2VzLmNob29zZVBhc3N3b3JkIHx8XG4gICAgICBgJHt0aGlzLnB1YmxpY1NlcnZlclVSTH0vYXBwcy9jaG9vc2VfcGFzc3dvcmRgXG4gICAgKTtcbiAgfVxuXG4gIGdldCByZXF1ZXN0UmVzZXRQYXNzd29yZFVSTCgpIHtcbiAgICByZXR1cm4gYCR7dGhpcy5wdWJsaWNTZXJ2ZXJVUkx9L2FwcHMvJHt0aGlzLmFwcGxpY2F0aW9uSWR9L3JlcXVlc3RfcGFzc3dvcmRfcmVzZXRgO1xuICB9XG5cbiAgZ2V0IHBhc3N3b3JkUmVzZXRTdWNjZXNzVVJMKCkge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLmN1c3RvbVBhZ2VzLnBhc3N3b3JkUmVzZXRTdWNjZXNzIHx8XG4gICAgICBgJHt0aGlzLnB1YmxpY1NlcnZlclVSTH0vYXBwcy9wYXNzd29yZF9yZXNldF9zdWNjZXNzLmh0bWxgXG4gICAgKTtcbiAgfVxuXG4gIGdldCBwYXJzZUZyYW1lVVJMKCkge1xuICAgIHJldHVybiB0aGlzLmN1c3RvbVBhZ2VzLnBhcnNlRnJhbWVVUkw7XG4gIH1cblxuICBnZXQgdmVyaWZ5RW1haWxVUkwoKSB7XG4gICAgcmV0dXJuIGAke3RoaXMucHVibGljU2VydmVyVVJMfS9hcHBzLyR7dGhpcy5hcHBsaWNhdGlvbklkfS92ZXJpZnlfZW1haWxgO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IENvbmZpZztcbm1vZHVsZS5leHBvcnRzID0gQ29uZmlnO1xuIl19
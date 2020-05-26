"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _RestQuery = _interopRequireDefault(require("./RestQuery"));

var _lodash = _interopRequireDefault(require("lodash"));

var _logger = _interopRequireDefault(require("./logger"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// A RestWrite encapsulates everything we need to run an operation
// that writes to the database.
// This could be either a "create" or an "update".
var SchemaController = require('./Controllers/SchemaController');

var deepcopy = require('deepcopy');

const Auth = require('./Auth');

var cryptoUtils = require('./cryptoUtils');

var passwordCrypto = require('./password');

var Parse = require('parse/node');

var triggers = require('./triggers');

var ClientSDK = require('./ClientSDK');

// query and data are both provided in REST API format. So data
// types are encoded by plain old objects.
// If query is null, this is a "create" and the data in data should be
// created.
// Otherwise this is an "update" - the object matching the query
// should get updated with data.
// RestWrite will handle objectId, createdAt, and updatedAt for
// everything. It also knows to use triggers and special modifications
// for the _User class.
function RestWrite(config, auth, className, query, data, originalData, clientSDK) {
  if (auth.isReadOnly) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Cannot perform a write operation when using readOnlyMasterKey');
  }

  this.config = config;
  this.auth = auth;
  this.className = className;
  this.clientSDK = clientSDK;
  this.storage = {};
  this.runOptions = {};
  this.context = {};

  if (!query && data.objectId) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'objectId is an invalid field name.');
  }

  if (!query && data.id) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'id is an invalid field name.');
  } // When the operation is complete, this.response may have several
  // fields.
  // response: the actual data to be returned
  // status: the http status code. if not present, treated like a 200
  // location: the location header. if not present, no location header


  this.response = null; // Processing this operation may mutate our data, so we operate on a
  // copy

  this.query = deepcopy(query);
  this.data = deepcopy(data); // We never change originalData, so we do not need a deep copy

  this.originalData = originalData; // The timestamp we'll use for this whole operation

  this.updatedAt = Parse._encode(new Date()).iso; // Shared SchemaController to be reused to reduce the number of loadSchema() calls per request
  // Once set the schemaData should be immutable

  this.validSchemaController = null;
} // A convenient method to perform all the steps of processing the
// write, in order.
// Returns a promise for a {response, status, location} object.
// status and location are optional.


RestWrite.prototype.execute = function () {
  return Promise.resolve().then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.handleInstallation();
  }).then(() => {
    return this.handleSession();
  }).then(() => {
    return this.validateAuthData();
  }).then(() => {
    return this.runBeforeSaveTrigger();
  }).then(() => {
    return this.deleteEmailResetTokenIfNeeded();
  }).then(() => {
    return this.validateSchema();
  }).then(schemaController => {
    this.validSchemaController = schemaController;
    return this.setRequiredFieldsIfNeeded();
  }).then(() => {
    return this.transformUser();
  }).then(() => {
    return this.expandFilesForExistingObjects();
  }).then(() => {
    return this.destroyDuplicatedSessions();
  }).then(() => {
    return this.runDatabaseOperation();
  }).then(() => {
    return this.createSessionTokenIfNeeded();
  }).then(() => {
    return this.handleFollowup();
  }).then(() => {
    return this.runAfterSaveTrigger();
  }).then(() => {
    return this.cleanUserAuthData();
  }).then(() => {
    return this.response;
  });
}; // Uses the Auth object to get the list of roles, adds the user id


RestWrite.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster) {
    return Promise.resolve();
  }

  this.runOptions.acl = ['*'];

  if (this.auth.user) {
    return this.auth.getUserRoles().then(roles => {
      this.runOptions.acl = this.runOptions.acl.concat(roles, [this.auth.user.id]);
      return;
    });
  } else {
    return Promise.resolve();
  }
}; // Validates this operation against the allowClientClassCreation config.


RestWrite.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className);
      }
    });
  } else {
    return Promise.resolve();
  }
}; // Validates this operation against the schema.


RestWrite.prototype.validateSchema = function () {
  return this.config.database.validateObject(this.className, this.data, this.query, this.runOptions);
}; // Runs any beforeSave triggers against this operation.
// Any change leads to our data being mutated.


RestWrite.prototype.runBeforeSaveTrigger = function () {
  if (this.response) {
    return;
  } // Avoid doing any setup for triggers if there is no 'beforeSave' trigger for this class.


  if (!triggers.triggerExists(this.className, triggers.Types.beforeSave, this.config.applicationId)) {
    return Promise.resolve();
  } // Cloud code gets a bit of extra data for its objects


  var extraData = {
    className: this.className
  };

  if (this.query && this.query.objectId) {
    extraData.objectId = this.query.objectId;
  }

  let originalObject = null;
  const updatedObject = this.buildUpdatedObject(extraData);

  if (this.query && this.query.objectId) {
    // This is an update for existing object.
    originalObject = triggers.inflate(extraData, this.originalData);
  }

  return Promise.resolve().then(() => {
    // Before calling the trigger, validate the permissions for the save operation
    let databasePromise = null;

    if (this.query) {
      // Validate for updating
      databasePromise = this.config.database.update(this.className, this.query, this.data, this.runOptions, false, true);
    } else {
      // Validate for creating
      databasePromise = this.config.database.create(this.className, this.data, this.runOptions, true);
    } // In the case that there is no permission for the operation, it throws an error


    return databasePromise.then(result => {
      if (!result || result.length <= 0) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }
    });
  }).then(() => {
    return triggers.maybeRunTrigger(triggers.Types.beforeSave, this.auth, updatedObject, originalObject, this.config, this.context);
  }).then(response => {
    if (response && response.object) {
      this.storage.fieldsChangedByTrigger = _lodash.default.reduce(response.object, (result, value, key) => {
        if (!_lodash.default.isEqual(this.data[key], value)) {
          result.push(key);
        }

        return result;
      }, []);
      this.data = response.object; // We should delete the objectId for an update write

      if (this.query && this.query.objectId) {
        delete this.data.objectId;
      }
    }
  });
};

RestWrite.prototype.runBeforeLoginTrigger = async function (userData) {
  // Avoid doing any setup for triggers if there is no 'beforeLogin' trigger
  if (!triggers.triggerExists(this.className, triggers.Types.beforeLogin, this.config.applicationId)) {
    return;
  } // Cloud code gets a bit of extra data for its objects


  const extraData = {
    className: this.className
  };
  const user = triggers.inflate(extraData, userData); // no need to return a response

  await triggers.maybeRunTrigger(triggers.Types.beforeLogin, this.auth, user, null, this.config, this.context);
};

RestWrite.prototype.setRequiredFieldsIfNeeded = function () {
  if (this.data) {
    return this.validSchemaController.getAllClasses().then(allClasses => {
      const schema = allClasses.find(oneClass => oneClass.className === this.className);

      const setRequiredFieldIfNeeded = (fieldName, setDefault) => {
        if (this.data[fieldName] === undefined || this.data[fieldName] === null || this.data[fieldName] === '' || typeof this.data[fieldName] === 'object' && this.data[fieldName].__op === 'Delete') {
          if (setDefault && schema.fields[fieldName] && schema.fields[fieldName].defaultValue !== null && schema.fields[fieldName].defaultValue !== undefined && (this.data[fieldName] === undefined || typeof this.data[fieldName] === 'object' && this.data[fieldName].__op === 'Delete')) {
            this.data[fieldName] = schema.fields[fieldName].defaultValue;
            this.storage.fieldsChangedByTrigger = this.storage.fieldsChangedByTrigger || [];

            if (this.storage.fieldsChangedByTrigger.indexOf(fieldName) < 0) {
              this.storage.fieldsChangedByTrigger.push(fieldName);
            }
          } else if (schema.fields[fieldName] && schema.fields[fieldName].required === true) {
            throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `${fieldName} is required`);
          }
        }
      };

      const assignObjectId = () => {
        const objectId = cryptoUtils.newObjectId(this.config.objectIdSize, this.config.objectIdUseTime);

        if (!this.config.objectIdPrefixes) {
          return objectId;
        }

        return this.config.objectIdPrefixes[this.className] ? `${this.config.objectIdPrefixes[this.className]}${objectId}` : objectId;
      }; // Add default fields


      this.data.updatedAt = this.updatedAt;

      if (!this.query) {
        this.data.createdAt = this.updatedAt; // Only assign new objectId if we are creating new object

        if (!this.data.objectId) {
          this.data.objectId = assignObjectId();
        }

        if (schema) {
          Object.keys(schema.fields).forEach(fieldName => {
            setRequiredFieldIfNeeded(fieldName, true);
          });
        }
      } else if (schema) {
        Object.keys(this.data).forEach(fieldName => {
          setRequiredFieldIfNeeded(fieldName, false);
        });
      }
    });
  }

  return Promise.resolve();
}; // Transforms auth data for a user object.
// Does nothing if this isn't a user object.
// Returns a promise for when we're done if it can't finish this tick.


RestWrite.prototype.validateAuthData = function () {
  if (this.className !== '_User') {
    return;
  }

  if (!this.query && !this.data.authData) {
    if (typeof this.data.username !== 'string' || _lodash.default.isEmpty(this.data.username)) {
      throw new Parse.Error(Parse.Error.USERNAME_MISSING, 'bad or missing username');
    }

    if (typeof this.data.password !== 'string' || _lodash.default.isEmpty(this.data.password)) {
      throw new Parse.Error(Parse.Error.PASSWORD_MISSING, 'password is required');
    }
  }

  if (!this.data.authData || !Object.keys(this.data.authData).length) {
    return;
  }

  var authData = this.data.authData;
  var providers = Object.keys(authData);

  if (providers.length > 0) {
    const canHandleAuthData = providers.reduce((canHandle, provider) => {
      var providerAuthData = authData[provider];
      var hasToken = providerAuthData && providerAuthData.id;
      return canHandle && (hasToken || providerAuthData == null);
    }, true);

    if (canHandleAuthData) {
      return this.handleAuthData(authData);
    }
  }

  throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
};

RestWrite.prototype.handleAuthDataValidation = function (authData) {
  const validations = Object.keys(authData).map(provider => {
    if (authData[provider] === null) {
      return Promise.resolve();
    }

    const validateAuthData = this.config.authDataManager.getValidatorForProvider(provider);

    if (!validateAuthData) {
      throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
    }

    return validateAuthData(authData[provider]);
  });
  return Promise.all(validations);
};

RestWrite.prototype.findUsersWithAuthData = function (authData) {
  const providers = Object.keys(authData);
  const query = providers.reduce((memo, provider) => {
    if (!authData[provider]) {
      return memo;
    }

    const queryKey = `authData.${provider}.id`;
    const query = {};
    query[queryKey] = authData[provider].id;
    memo.push(query);
    return memo;
  }, []).filter(q => {
    return typeof q !== 'undefined';
  });
  let findPromise = Promise.resolve([]);

  if (query.length > 0) {
    findPromise = this.config.database.find(this.className, {
      $or: query
    }, {});
  }

  return findPromise;
};

RestWrite.prototype.filteredObjectsByACL = function (objects) {
  if (this.auth.isMaster) {
    return objects;
  }

  return objects.filter(object => {
    if (!object.ACL) {
      return true; // legacy users that have no ACL field on them
    } // Regular users that have been locked out.


    return object.ACL && Object.keys(object.ACL).length > 0;
  });
};

RestWrite.prototype.handleAuthData = function (authData) {
  let results;
  return this.findUsersWithAuthData(authData).then(async r => {
    results = this.filteredObjectsByACL(r);

    if (results.length == 1) {
      this.storage['authProvider'] = Object.keys(authData).join(',');
      const userResult = results[0];
      const mutatedAuthData = {};
      Object.keys(authData).forEach(provider => {
        const providerData = authData[provider];
        const userAuthData = userResult.authData[provider];

        if (!_lodash.default.isEqual(providerData, userAuthData)) {
          mutatedAuthData[provider] = providerData;
        }
      });
      const hasMutatedAuthData = Object.keys(mutatedAuthData).length !== 0;
      let userId;

      if (this.query && this.query.objectId) {
        userId = this.query.objectId;
      } else if (this.auth && this.auth.user && this.auth.user.id) {
        userId = this.auth.user.id;
      }

      if (!userId || userId === userResult.objectId) {
        // no user making the call
        // OR the user making the call is the right one
        // Login with auth data
        delete results[0].password; // need to set the objectId first otherwise location has trailing undefined

        this.data.objectId = userResult.objectId;

        if (!this.query || !this.query.objectId) {
          // this a login call, no userId passed
          this.response = {
            response: userResult,
            location: this.location()
          }; // Run beforeLogin hook before storing any updates
          // to authData on the db; changes to userResult
          // will be ignored.

          await this.runBeforeLoginTrigger(deepcopy(userResult));
        } // If we didn't change the auth data, just keep going


        if (!hasMutatedAuthData) {
          return;
        } // We have authData that is updated on login
        // that can happen when token are refreshed,
        // We should update the token and let the user in
        // We should only check the mutated keys


        return this.handleAuthDataValidation(mutatedAuthData).then(async () => {
          // IF we have a response, we'll skip the database operation / beforeSave / afterSave etc...
          // we need to set it up there.
          // We are supposed to have a response only on LOGIN with authData, so we skip those
          // If we're not logging in, but just updating the current user, we can safely skip that part
          if (this.response) {
            // Assign the new authData in the response
            Object.keys(mutatedAuthData).forEach(provider => {
              this.response.response.authData[provider] = mutatedAuthData[provider];
            }); // Run the DB update directly, as 'master'
            // Just update the authData part
            // Then we're good for the user, early exit of sorts

            return this.config.database.update(this.className, {
              objectId: this.data.objectId
            }, {
              authData: mutatedAuthData
            }, {});
          }
        });
      } else if (userId) {
        // Trying to update auth data but users
        // are different
        if (userResult.objectId !== userId) {
          throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
        } // No auth data was mutated, just keep going


        if (!hasMutatedAuthData) {
          return;
        }
      }
    }

    return this.handleAuthDataValidation(authData).then(() => {
      if (results.length > 1) {
        // More than 1 user with the passed id's
        throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
      }
    });
  });
}; // The non-third-party parts of User transformation


RestWrite.prototype.transformUser = function () {
  var promise = Promise.resolve();

  if (this.className !== '_User') {
    return promise;
  }

  if (!this.auth.isMaster && 'emailVerified' in this.data) {
    const error = `Clients aren't allowed to manually update email verification.`;
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, error);
  } // Do not cleanup session if objectId is not set


  if (this.query && this.objectId()) {
    // If we're updating a _User object, we need to clear out the cache for that user. Find all their
    // session tokens, and remove them from the cache.
    promise = new _RestQuery.default(this.config, Auth.master(this.config), '_Session', {
      user: {
        __type: 'Pointer',
        className: '_User',
        objectId: this.objectId()
      }
    }).execute().then(results => {
      results.results.forEach(session => this.config.cacheController.user.del(session.sessionToken));
    });
  }

  return promise.then(() => {
    // Transform the password
    if (this.data.password === undefined) {
      // ignore only if undefined. should proceed if empty ('')
      return Promise.resolve();
    }

    if (this.query) {
      this.storage['clearSessions'] = true; // Generate a new session only if the user requested

      if (!this.auth.isMaster) {
        this.storage['generateNewSession'] = true;
      }
    }

    return this._validatePasswordPolicy().then(() => {
      return passwordCrypto.hash(this.data.password).then(hashedPassword => {
        this.data._hashed_password = hashedPassword;
        delete this.data.password;
      });
    });
  }).then(() => {
    return this._validateUserName();
  }).then(() => {
    return this._validateEmail();
  });
};

RestWrite.prototype._validateUserName = function () {
  // Check for username uniqueness
  if (!this.data.username) {
    if (!this.query) {
      this.data.username = cryptoUtils.randomString(25);
      this.responseShouldHaveUsername = true;
    }

    return Promise.resolve();
  } // We need to a find to check for duplicate username in case they are missing the unique index on usernames
  // TODO: Check if there is a unique index, and if so, skip this query.


  return this.config.database.find(this.className, {
    username: this.data.username,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1
  }, {}, this.validSchemaController).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
    }

    return;
  });
};

RestWrite.prototype._validateEmail = function () {
  if (!this.data.email || this.data.email.__op === 'Delete') {
    return Promise.resolve();
  } // Validate basic email address format


  if (!this.data.email.match(/^.+@.+$/)) {
    return Promise.reject(new Parse.Error(Parse.Error.INVALID_EMAIL_ADDRESS, 'Email address format is invalid.'));
  } // Same problem for email as above for username


  return this.config.database.find(this.className, {
    email: this.data.email,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1
  }, {}, this.validSchemaController).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
    }

    if (!this.data.authData || !Object.keys(this.data.authData).length || Object.keys(this.data.authData).length === 1 && Object.keys(this.data.authData)[0] === 'anonymous') {
      // We updated the email, send a new validation
      this.storage['sendVerificationEmail'] = true;
      this.config.userController.setEmailVerifyToken(this.data);
    }
  });
};

RestWrite.prototype._validatePasswordPolicy = function () {
  if (!this.config.passwordPolicy) return Promise.resolve();
  return this._validatePasswordRequirements().then(() => {
    return this._validatePasswordHistory();
  });
};

RestWrite.prototype._validatePasswordRequirements = function () {
  // check if the password conforms to the defined password policy if configured
  // If we specified a custom error in our configuration use it.
  // Example: "Passwords must include a Capital Letter, Lowercase Letter, and a number."
  //
  // This is especially useful on the generic "password reset" page,
  // as it allows the programmer to communicate specific requirements instead of:
  // a. making the user guess whats wrong
  // b. making a custom password reset page that shows the requirements
  const policyError = this.config.passwordPolicy.validationError ? this.config.passwordPolicy.validationError : 'Password does not meet the Password Policy requirements.';
  const containsUsernameError = 'Password cannot contain your username.'; // check whether the password meets the password strength requirements

  if (this.config.passwordPolicy.patternValidator && !this.config.passwordPolicy.patternValidator(this.data.password) || this.config.passwordPolicy.validatorCallback && !this.config.passwordPolicy.validatorCallback(this.data.password)) {
    return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, policyError));
  } // check whether password contain username


  if (this.config.passwordPolicy.doNotAllowUsername === true) {
    if (this.data.username) {
      // username is not passed during password reset
      if (this.data.password.indexOf(this.data.username) >= 0) return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
    } else {
      // retrieve the User object using objectId during password reset
      return this.config.database.find('_User', {
        objectId: this.objectId()
      }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }

        if (this.data.password.indexOf(results[0].username) >= 0) return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
        return Promise.resolve();
      });
    }
  }

  return Promise.resolve();
};

RestWrite.prototype._validatePasswordHistory = function () {
  // check whether password is repeating from specified history
  if (this.query && this.config.passwordPolicy.maxPasswordHistory) {
    return this.config.database.find('_User', {
      objectId: this.objectId()
    }, {
      keys: ['_password_history', '_hashed_password']
    }).then(results => {
      if (results.length != 1) {
        throw undefined;
      }

      const user = results[0];
      let oldPasswords = [];
      if (user._password_history) oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory - 1);
      oldPasswords.push(user.password);
      const newPassword = this.data.password; // compare the new password hash with all old password hashes

      const promises = oldPasswords.map(function (hash) {
        return passwordCrypto.compare(newPassword, hash).then(result => {
          if (result) // reject if there is a match
            return Promise.reject('REPEAT_PASSWORD');
          return Promise.resolve();
        });
      }); // wait for all comparisons to complete

      return Promise.all(promises).then(() => {
        return Promise.resolve();
      }).catch(err => {
        if (err === 'REPEAT_PASSWORD') // a match was found
          return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, `New password should not be the same as last ${this.config.passwordPolicy.maxPasswordHistory} passwords.`));
        throw err;
      });
    });
  }

  return Promise.resolve();
};

RestWrite.prototype.createSessionTokenIfNeeded = function () {
  if (this.className !== '_User') {
    return;
  } // Don't generate session for updating user (this.query is set) unless authData exists


  if (this.query && !this.data.authData) {
    return;
  } // Don't generate new sessionToken if linking via sessionToken


  if (this.auth.user && this.data.authData) {
    return;
  }

  if (!this.storage['authProvider'] && // signup call, with
  this.config.preventLoginWithUnverifiedEmail && // no login without verification
  this.config.verifyUserEmails) {
    // verification is on
    return; // do not create the session token in that case!
  }

  return this.createSessionToken();
};

RestWrite.prototype.createSessionToken = async function () {
  // cloud installationId from Cloud Code,
  // never create session tokens from there.
  if (this.auth.installationId && this.auth.installationId === 'cloud') {
    return;
  }

  const {
    sessionData,
    createSession
  } = Auth.createSession(this.config, {
    userId: this.objectId(),
    createdWith: {
      action: this.storage['authProvider'] ? 'login' : 'signup',
      authProvider: this.storage['authProvider'] || 'password'
    },
    installationId: this.auth.installationId
  });

  if (this.response && this.response.response) {
    this.response.response.sessionToken = sessionData.sessionToken;
  }

  return createSession();
}; // Delete email reset tokens if user is changing password or email.


RestWrite.prototype.deleteEmailResetTokenIfNeeded = function () {
  if (this.className !== '_User' || this.query === null) {
    // null query means create
    return;
  }

  if ('password' in this.data || 'email' in this.data) {
    const addOps = {
      _perishable_token: {
        __op: 'Delete'
      },
      _perishable_token_expires_at: {
        __op: 'Delete'
      }
    };
    this.data = Object.assign(this.data, addOps);
  }
};

RestWrite.prototype.destroyDuplicatedSessions = function () {
  // Only for _Session, and at creation time
  if (this.className != '_Session' || this.query) {
    return;
  } // Destroy the sessions in 'Background'


  const {
    user,
    installationId,
    sessionToken
  } = this.data;

  if (!user || !installationId) {
    return;
  }

  if (!user.objectId) {
    return;
  }

  this.config.database.destroy('_Session', {
    user,
    installationId,
    sessionToken: {
      $ne: sessionToken
    }
  }, {}, this.validSchemaController);
}; // Handles any followup logic


RestWrite.prototype.handleFollowup = function () {
  if (this.storage && this.storage['clearSessions'] && this.config.revokeSessionOnPasswordReset) {
    var sessionQuery = {
      user: {
        __type: 'Pointer',
        className: '_User',
        objectId: this.objectId()
      }
    };
    delete this.storage['clearSessions'];
    return this.config.database.destroy('_Session', sessionQuery).then(this.handleFollowup.bind(this));
  }

  if (this.storage && this.storage['generateNewSession']) {
    delete this.storage['generateNewSession'];
    return this.createSessionToken().then(this.handleFollowup.bind(this));
  }

  if (this.storage && this.storage['sendVerificationEmail']) {
    delete this.storage['sendVerificationEmail']; // Fire and forget!

    this.config.userController.sendVerificationEmail(this.data);
    return this.handleFollowup.bind(this);
  }
}; // Handles the _Session class specialness.
// Does nothing if this isn't an _Session object.


RestWrite.prototype.handleSession = function () {
  if (this.response || this.className !== '_Session') {
    return;
  }

  if (!this.auth.user && !this.auth.isMaster) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token required.');
  } // TODO: Verify proper error to throw


  if (this.data.ACL) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Cannot set ' + 'ACL on a Session.');
  }

  if (this.query) {
    if (this.data.user && !this.auth.isMaster && this.data.user.objectId != this.auth.user.id) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    } else if (this.data.installationId) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    } else if (this.data.sessionToken) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    }
  }

  if (!this.query && !this.auth.isMaster) {
    const additionalSessionData = {};

    for (var key in this.data) {
      if (key === 'objectId' || key === 'user') {
        continue;
      }

      additionalSessionData[key] = this.data[key];
    }

    const {
      sessionData,
      createSession
    } = Auth.createSession(this.config, {
      userId: this.auth.user.id,
      createdWith: {
        action: 'create'
      },
      additionalSessionData
    });
    return createSession().then(results => {
      if (!results.response) {
        throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Error creating session.');
      }

      sessionData['objectId'] = results.response['objectId'];
      this.response = {
        status: 201,
        location: results.location,
        response: sessionData
      };
    });
  }
}; // Handles the _Installation class specialness.
// Does nothing if this isn't an installation object.
// If an installation is found, this can mutate this.query and turn a create
// into an update.
// Returns a promise for when we're done if it can't finish this tick.


RestWrite.prototype.handleInstallation = function () {
  if (this.response || this.className !== '_Installation') {
    return;
  }

  if (!this.query && !this.data.deviceToken && !this.data.installationId && !this.auth.installationId) {
    throw new Parse.Error(135, 'at least one ID field (deviceToken, installationId) ' + 'must be specified in this operation');
  } // If the device token is 64 characters long, we assume it is for iOS
  // and lowercase it.


  if (this.data.deviceToken && this.data.deviceToken.length == 64) {
    this.data.deviceToken = this.data.deviceToken.toLowerCase();
  } // We lowercase the installationId if present


  if (this.data.installationId) {
    this.data.installationId = this.data.installationId.toLowerCase();
  }

  let installationId = this.data.installationId; // If data.installationId is not set and we're not master, we can lookup in auth

  if (!installationId && !this.auth.isMaster) {
    installationId = this.auth.installationId;
  }

  if (installationId) {
    installationId = installationId.toLowerCase();
  } // Updating _Installation but not updating anything critical


  if (this.query && !this.data.deviceToken && !installationId && !this.data.deviceType) {
    return;
  }

  var promise = Promise.resolve();
  var idMatch; // Will be a match on either objectId or installationId

  var objectIdMatch;
  var installationIdMatch;
  var deviceTokenMatches = []; // Instead of issuing 3 reads, let's do it with one OR.

  const orQueries = [];

  if (this.query && this.query.objectId) {
    orQueries.push({
      objectId: this.query.objectId
    });
  }

  if (installationId) {
    orQueries.push({
      installationId: installationId
    });
  }

  if (this.data.deviceToken) {
    orQueries.push({
      deviceToken: this.data.deviceToken
    });
  }

  if (orQueries.length == 0) {
    return;
  }

  promise = promise.then(() => {
    return this.config.database.find('_Installation', {
      $or: orQueries
    }, {});
  }).then(results => {
    results.forEach(result => {
      if (this.query && this.query.objectId && result.objectId == this.query.objectId) {
        objectIdMatch = result;
      }

      if (result.installationId == installationId) {
        installationIdMatch = result;
      }

      if (result.deviceToken == this.data.deviceToken) {
        deviceTokenMatches.push(result);
      }
    }); // Sanity checks when running a query

    if (this.query && this.query.objectId) {
      if (!objectIdMatch) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found for update.');
      }

      if (this.data.installationId && objectIdMatch.installationId && this.data.installationId !== objectIdMatch.installationId) {
        throw new Parse.Error(136, 'installationId may not be changed in this ' + 'operation');
      }

      if (this.data.deviceToken && objectIdMatch.deviceToken && this.data.deviceToken !== objectIdMatch.deviceToken && !this.data.installationId && !objectIdMatch.installationId) {
        throw new Parse.Error(136, 'deviceToken may not be changed in this ' + 'operation');
      }

      if (this.data.deviceType && this.data.deviceType && this.data.deviceType !== objectIdMatch.deviceType) {
        throw new Parse.Error(136, 'deviceType may not be changed in this ' + 'operation');
      }
    }

    if (this.query && this.query.objectId && objectIdMatch) {
      idMatch = objectIdMatch;
    }

    if (installationId && installationIdMatch) {
      idMatch = installationIdMatch;
    } // need to specify deviceType only if it's new


    if (!this.query && !this.data.deviceType && !idMatch) {
      throw new Parse.Error(135, 'deviceType must be specified in this operation');
    }
  }).then(() => {
    if (!idMatch) {
      if (!deviceTokenMatches.length) {
        return;
      } else if (deviceTokenMatches.length == 1 && (!deviceTokenMatches[0]['installationId'] || !installationId)) {
        // Single match on device token but none on installationId, and either
        // the passed object or the match is missing an installationId, so we
        // can just return the match.
        return deviceTokenMatches[0]['objectId'];
      } else if (!this.data.installationId) {
        throw new Parse.Error(132, 'Must specify installationId when deviceToken ' + 'matches multiple Installation objects');
      } else {
        // Multiple device token matches and we specified an installation ID,
        // or a single match where both the passed and matching objects have
        // an installation ID. Try cleaning out old installations that match
        // the deviceToken, and return nil to signal that a new object should
        // be created.
        var delQuery = {
          deviceToken: this.data.deviceToken,
          installationId: {
            $ne: installationId
          }
        };

        if (this.data.appIdentifier) {
          delQuery['appIdentifier'] = this.data.appIdentifier;
        }

        this.config.database.destroy('_Installation', delQuery).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored.
            return;
          } // rethrow the error


          throw err;
        });
        return;
      }
    } else {
      if (deviceTokenMatches.length == 1 && !deviceTokenMatches[0]['installationId']) {
        // Exactly one device token match and it doesn't have an installation
        // ID. This is the one case where we want to merge with the existing
        // object.
        const delQuery = {
          objectId: idMatch.objectId
        };
        return this.config.database.destroy('_Installation', delQuery).then(() => {
          return deviceTokenMatches[0]['objectId'];
        }).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored
            return;
          } // rethrow the error


          throw err;
        });
      } else {
        if (this.data.deviceToken && idMatch.deviceToken != this.data.deviceToken) {
          // We're setting the device token on an existing installation, so
          // we should try cleaning out old installations that match this
          // device token.
          const delQuery = {
            deviceToken: this.data.deviceToken
          }; // We have a unique install Id, use that to preserve
          // the interesting installation

          if (this.data.installationId) {
            delQuery['installationId'] = {
              $ne: this.data.installationId
            };
          } else if (idMatch.objectId && this.data.objectId && idMatch.objectId == this.data.objectId) {
            // we passed an objectId, preserve that instalation
            delQuery['objectId'] = {
              $ne: idMatch.objectId
            };
          } else {
            // What to do here? can't really clean up everything...
            return idMatch.objectId;
          }

          if (this.data.appIdentifier) {
            delQuery['appIdentifier'] = this.data.appIdentifier;
          }

          this.config.database.destroy('_Installation', delQuery).catch(err => {
            if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
              // no deletions were made. Can be ignored.
              return;
            } // rethrow the error


            throw err;
          });
        } // In non-merge scenarios, just return the installation match id


        return idMatch.objectId;
      }
    }
  }).then(objId => {
    if (objId) {
      this.query = {
        objectId: objId
      };
      delete this.data.objectId;
      delete this.data.createdAt;
    } // TODO: Validate ops (add/remove on channels, $inc on badge, etc.)

  });
  return promise;
}; // If we short-circuted the object response - then we need to make sure we expand all the files,
// since this might not have a query, meaning it won't return the full result back.
// TODO: (nlutsenko) This should die when we move to per-class based controllers on _Session/_User


RestWrite.prototype.expandFilesForExistingObjects = function () {
  // Check whether we have a short-circuited response - only then run expansion.
  if (this.response && this.response.response) {
    this.config.filesController.expandFilesInObject(this.config, this.response.response);
  }
};

RestWrite.prototype.runDatabaseOperation = function () {
  if (this.response) {
    return;
  }

  if (this.className === '_Role') {
    this.config.cacheController.role.clear();
  }

  if (this.className === '_User' && this.query && this.auth.isUnauthenticated()) {
    throw new Parse.Error(Parse.Error.SESSION_MISSING, `Cannot modify user ${this.query.objectId}.`);
  }

  if (this.className === '_Product' && this.data.download) {
    this.data.downloadName = this.data.download.name;
  } // TODO: Add better detection for ACL, ensuring a user can't be locked from
  //       their own user record.


  if (this.data.ACL && this.data.ACL['*unresolved']) {
    throw new Parse.Error(Parse.Error.INVALID_ACL, 'Invalid ACL.');
  }

  if (this.query) {
    // Force the user to not lockout
    // Matched with parse.com
    if (this.className === '_User' && this.data.ACL && this.auth.isMaster !== true) {
      this.data.ACL[this.query.objectId] = {
        read: true,
        write: true
      };
    } // update password timestamp if user password is being changed


    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
      this.data._password_changed_at = Parse._encode(new Date());
    } // Ignore createdAt when update


    delete this.data.createdAt;
    let defer = Promise.resolve(); // if password history is enabled then save the current password to history

    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordHistory) {
      defer = this.config.database.find('_User', {
        objectId: this.objectId()
      }, {
        keys: ['_password_history', '_hashed_password']
      }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }

        const user = results[0];
        let oldPasswords = [];

        if (user._password_history) {
          oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory);
        } //n-1 passwords go into history including last password


        while (oldPasswords.length > Math.max(0, this.config.passwordPolicy.maxPasswordHistory - 2)) {
          oldPasswords.shift();
        }

        oldPasswords.push(user.password);
        this.data._password_history = oldPasswords;
      });
    }

    return defer.then(() => {
      // Run an update
      return this.config.database.update(this.className, this.query, this.data, this.runOptions, false, false, this.validSchemaController).then(response => {
        response.updatedAt = this.updatedAt;

        this._updateResponseWithData(response, this.data);

        this.response = {
          response
        };
      });
    });
  } else {
    // Set the default ACL and password timestamp for the new _User
    if (this.className === '_User') {
      var ACL = this.data.ACL; // default public r/w ACL

      if (!ACL) {
        ACL = {};
        ACL['*'] = {
          read: true,
          write: false
        };
      } // make sure the user is not locked down


      ACL[this.data.objectId] = {
        read: true,
        write: true
      };
      this.data.ACL = ACL; // password timestamp to be used when password expiry policy is enforced

      if (this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
        this.data._password_changed_at = Parse._encode(new Date());
      }
    } // Run a create


    return this.config.database.create(this.className, this.data, this.runOptions, false, this.validSchemaController).catch(error => {
      if (this.className !== '_User' || error.code !== Parse.Error.DUPLICATE_VALUE) {
        throw error;
      } // Quick check, if we were able to infer the duplicated field name


      if (error && error.userInfo && error.userInfo.duplicated_field === 'username') {
        throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
      }

      if (error && error.userInfo && error.userInfo.duplicated_field === 'email') {
        throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
      } // If this was a failed user creation due to username or email already taken, we need to
      // check whether it was username or email and return the appropriate error.
      // Fallback to the original method
      // TODO: See if we can later do this without additional queries by using named indexes.


      return this.config.database.find(this.className, {
        username: this.data.username,
        objectId: {
          $ne: this.objectId()
        }
      }, {
        limit: 1
      }).then(results => {
        if (results.length > 0) {
          throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
        }

        return this.config.database.find(this.className, {
          email: this.data.email,
          objectId: {
            $ne: this.objectId()
          }
        }, {
          limit: 1
        });
      }).then(results => {
        if (results.length > 0) {
          throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
        }

        throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      });
    }).then(response => {
      response.objectId = this.data.objectId;
      response.createdAt = this.data.createdAt;

      if (this.responseShouldHaveUsername) {
        response.username = this.data.username;
      }

      this._updateResponseWithData(response, this.data);

      this.response = {
        status: 201,
        response,
        location: this.location()
      };
    });
  }
}; // Returns nothing - doesn't wait for the trigger.


RestWrite.prototype.runAfterSaveTrigger = function () {
  if (!this.response || !this.response.response) {
    return;
  } // Avoid doing any setup for triggers if there is no 'afterSave' trigger for this class.


  const hasAfterSaveHook = triggers.triggerExists(this.className, triggers.Types.afterSave, this.config.applicationId);
  const hasLiveQuery = this.config.liveQueryController.hasLiveQuery(this.className);

  if (!hasAfterSaveHook && !hasLiveQuery) {
    return Promise.resolve();
  }

  var extraData = {
    className: this.className
  };

  if (this.query && this.query.objectId) {
    extraData.objectId = this.query.objectId;
  } // Build the original object, we only do this for a update write.


  let originalObject;

  if (this.query && this.query.objectId) {
    originalObject = triggers.inflate(extraData, this.originalData);
  } // Build the inflated object, different from beforeSave, originalData is not empty
  // since developers can change data in the beforeSave.


  const updatedObject = this.buildUpdatedObject(extraData);

  updatedObject._handleSaveResponse(this.response.response, this.response.status || 200);

  this.config.database.loadSchema().then(schemaController => {
    // Notifiy LiveQueryServer if possible
    const perms = schemaController.getClassLevelPermissions(updatedObject.className);
    this.config.liveQueryController.onAfterSave(updatedObject.className, updatedObject, originalObject, perms);
  }); // Run afterSave trigger

  return triggers.maybeRunTrigger(triggers.Types.afterSave, this.auth, updatedObject, originalObject, this.config, this.context).then(result => {
    if (result && typeof result === 'object') {
      this.response.response = result;
    }
  }).catch(function (err) {
    _logger.default.warn('afterSave caught an error', err);
  });
}; // A helper to figure out what location this operation happens at.


RestWrite.prototype.location = function () {
  var middle = this.className === '_User' ? '/users/' : '/classes/' + this.className + '/';
  return this.config.mount + middle + this.data.objectId;
}; // A helper to get the object id for this operation.
// Because it could be either on the query or on the data


RestWrite.prototype.objectId = function () {
  return this.data.objectId || this.query.objectId;
}; // Returns a copy of the data and delete bad keys (_auth_data, _hashed_password...)


RestWrite.prototype.sanitizedData = function () {
  const data = Object.keys(this.data).reduce((data, key) => {
    // Regexp comes from Parse.Object.prototype.validate
    if (!/^[A-Za-z][0-9A-Za-z_]*$/.test(key)) {
      delete data[key];
    }

    return data;
  }, deepcopy(this.data));
  return Parse._decode(undefined, data);
}; // Returns an updated copy of the object


RestWrite.prototype.buildUpdatedObject = function (extraData) {
  const updatedObject = triggers.inflate(extraData, this.originalData);
  Object.keys(this.data).reduce(function (data, key) {
    if (key.indexOf('.') > 0) {
      // subdocument key with dot notation ('x.y':v => 'x':{'y':v})
      const splittedKey = key.split('.');
      const parentProp = splittedKey[0];
      let parentVal = updatedObject.get(parentProp);

      if (typeof parentVal !== 'object') {
        parentVal = {};
      }

      parentVal[splittedKey[1]] = data[key];
      updatedObject.set(parentProp, parentVal);
      delete data[key];
    }

    return data;
  }, deepcopy(this.data));
  updatedObject.set(this.sanitizedData());
  return updatedObject;
};

RestWrite.prototype.cleanUserAuthData = function () {
  if (this.response && this.response.response && this.className === '_User') {
    const user = this.response.response;

    if (user.authData) {
      Object.keys(user.authData).forEach(provider => {
        if (user.authData[provider] === null) {
          delete user.authData[provider];
        }
      });

      if (Object.keys(user.authData).length == 0) {
        delete user.authData;
      }
    }
  }
};

RestWrite.prototype._updateResponseWithData = function (response, data) {
  if (_lodash.default.isEmpty(this.storage.fieldsChangedByTrigger)) {
    return response;
  }

  const clientSupportsDelete = ClientSDK.supportsForwardDelete(this.clientSDK);
  this.storage.fieldsChangedByTrigger.forEach(fieldName => {
    const dataValue = data[fieldName];

    if (!Object.prototype.hasOwnProperty.call(response, fieldName)) {
      response[fieldName] = dataValue;
    } // Strips operations from responses


    if (response[fieldName] && response[fieldName].__op) {
      delete response[fieldName];

      if (clientSupportsDelete && dataValue.__op == 'Delete') {
        response[fieldName] = dataValue;
      }
    }
  });
  return response;
};

var _default = RestWrite;
exports.default = _default;
module.exports = RestWrite;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0V3JpdGUuanMiXSwibmFtZXMiOlsiU2NoZW1hQ29udHJvbGxlciIsInJlcXVpcmUiLCJkZWVwY29weSIsIkF1dGgiLCJjcnlwdG9VdGlscyIsInBhc3N3b3JkQ3J5cHRvIiwiUGFyc2UiLCJ0cmlnZ2VycyIsIkNsaWVudFNESyIsIlJlc3RXcml0ZSIsImNvbmZpZyIsImF1dGgiLCJjbGFzc05hbWUiLCJxdWVyeSIsImRhdGEiLCJvcmlnaW5hbERhdGEiLCJjbGllbnRTREsiLCJpc1JlYWRPbmx5IiwiRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwic3RvcmFnZSIsInJ1bk9wdGlvbnMiLCJjb250ZXh0Iiwib2JqZWN0SWQiLCJJTlZBTElEX0tFWV9OQU1FIiwiaWQiLCJyZXNwb25zZSIsInVwZGF0ZWRBdCIsIl9lbmNvZGUiLCJEYXRlIiwiaXNvIiwidmFsaWRTY2hlbWFDb250cm9sbGVyIiwicHJvdG90eXBlIiwiZXhlY3V0ZSIsIlByb21pc2UiLCJyZXNvbHZlIiwidGhlbiIsImdldFVzZXJBbmRSb2xlQUNMIiwidmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uIiwiaGFuZGxlSW5zdGFsbGF0aW9uIiwiaGFuZGxlU2Vzc2lvbiIsInZhbGlkYXRlQXV0aERhdGEiLCJydW5CZWZvcmVTYXZlVHJpZ2dlciIsImRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkIiwidmFsaWRhdGVTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwic2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCIsInRyYW5zZm9ybVVzZXIiLCJleHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyIsImRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMiLCJydW5EYXRhYmFzZU9wZXJhdGlvbiIsImNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkIiwiaGFuZGxlRm9sbG93dXAiLCJydW5BZnRlclNhdmVUcmlnZ2VyIiwiY2xlYW5Vc2VyQXV0aERhdGEiLCJpc01hc3RlciIsImFjbCIsInVzZXIiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsImNvbmNhdCIsImFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiIsInN5c3RlbUNsYXNzZXMiLCJpbmRleE9mIiwiZGF0YWJhc2UiLCJsb2FkU2NoZW1hIiwiaGFzQ2xhc3MiLCJ2YWxpZGF0ZU9iamVjdCIsInRyaWdnZXJFeGlzdHMiLCJUeXBlcyIsImJlZm9yZVNhdmUiLCJhcHBsaWNhdGlvbklkIiwiZXh0cmFEYXRhIiwib3JpZ2luYWxPYmplY3QiLCJ1cGRhdGVkT2JqZWN0IiwiYnVpbGRVcGRhdGVkT2JqZWN0IiwiaW5mbGF0ZSIsImRhdGFiYXNlUHJvbWlzZSIsInVwZGF0ZSIsImNyZWF0ZSIsInJlc3VsdCIsImxlbmd0aCIsIk9CSkVDVF9OT1RfRk9VTkQiLCJtYXliZVJ1blRyaWdnZXIiLCJvYmplY3QiLCJmaWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIiwiXyIsInJlZHVjZSIsInZhbHVlIiwia2V5IiwiaXNFcXVhbCIsInB1c2giLCJydW5CZWZvcmVMb2dpblRyaWdnZXIiLCJ1c2VyRGF0YSIsImJlZm9yZUxvZ2luIiwiZ2V0QWxsQ2xhc3NlcyIsImFsbENsYXNzZXMiLCJzY2hlbWEiLCJmaW5kIiwib25lQ2xhc3MiLCJzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQiLCJmaWVsZE5hbWUiLCJzZXREZWZhdWx0IiwidW5kZWZpbmVkIiwiX19vcCIsImZpZWxkcyIsImRlZmF1bHRWYWx1ZSIsInJlcXVpcmVkIiwiVkFMSURBVElPTl9FUlJPUiIsImFzc2lnbk9iamVjdElkIiwibmV3T2JqZWN0SWQiLCJvYmplY3RJZFNpemUiLCJvYmplY3RJZFVzZVRpbWUiLCJvYmplY3RJZFByZWZpeGVzIiwiY3JlYXRlZEF0IiwiT2JqZWN0Iiwia2V5cyIsImZvckVhY2giLCJhdXRoRGF0YSIsInVzZXJuYW1lIiwiaXNFbXB0eSIsIlVTRVJOQU1FX01JU1NJTkciLCJwYXNzd29yZCIsIlBBU1NXT1JEX01JU1NJTkciLCJwcm92aWRlcnMiLCJjYW5IYW5kbGVBdXRoRGF0YSIsImNhbkhhbmRsZSIsInByb3ZpZGVyIiwicHJvdmlkZXJBdXRoRGF0YSIsImhhc1Rva2VuIiwiaGFuZGxlQXV0aERhdGEiLCJVTlNVUFBPUlRFRF9TRVJWSUNFIiwiaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uIiwidmFsaWRhdGlvbnMiLCJtYXAiLCJhdXRoRGF0YU1hbmFnZXIiLCJnZXRWYWxpZGF0b3JGb3JQcm92aWRlciIsImFsbCIsImZpbmRVc2Vyc1dpdGhBdXRoRGF0YSIsIm1lbW8iLCJxdWVyeUtleSIsImZpbHRlciIsInEiLCJmaW5kUHJvbWlzZSIsIiRvciIsImZpbHRlcmVkT2JqZWN0c0J5QUNMIiwib2JqZWN0cyIsIkFDTCIsInJlc3VsdHMiLCJyIiwiam9pbiIsInVzZXJSZXN1bHQiLCJtdXRhdGVkQXV0aERhdGEiLCJwcm92aWRlckRhdGEiLCJ1c2VyQXV0aERhdGEiLCJoYXNNdXRhdGVkQXV0aERhdGEiLCJ1c2VySWQiLCJsb2NhdGlvbiIsIkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQiLCJwcm9taXNlIiwiZXJyb3IiLCJSZXN0UXVlcnkiLCJtYXN0ZXIiLCJfX3R5cGUiLCJzZXNzaW9uIiwiY2FjaGVDb250cm9sbGVyIiwiZGVsIiwic2Vzc2lvblRva2VuIiwiX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kiLCJoYXNoIiwiaGFzaGVkUGFzc3dvcmQiLCJfaGFzaGVkX3Bhc3N3b3JkIiwiX3ZhbGlkYXRlVXNlck5hbWUiLCJfdmFsaWRhdGVFbWFpbCIsInJhbmRvbVN0cmluZyIsInJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lIiwiJG5lIiwibGltaXQiLCJVU0VSTkFNRV9UQUtFTiIsImVtYWlsIiwibWF0Y2giLCJyZWplY3QiLCJJTlZBTElEX0VNQUlMX0FERFJFU1MiLCJFTUFJTF9UQUtFTiIsInVzZXJDb250cm9sbGVyIiwic2V0RW1haWxWZXJpZnlUb2tlbiIsInBhc3N3b3JkUG9saWN5IiwiX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMiLCJfdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkiLCJwb2xpY3lFcnJvciIsInZhbGlkYXRpb25FcnJvciIsImNvbnRhaW5zVXNlcm5hbWVFcnJvciIsInBhdHRlcm5WYWxpZGF0b3IiLCJ2YWxpZGF0b3JDYWxsYmFjayIsImRvTm90QWxsb3dVc2VybmFtZSIsIm1heFBhc3N3b3JkSGlzdG9yeSIsIm9sZFBhc3N3b3JkcyIsIl9wYXNzd29yZF9oaXN0b3J5IiwidGFrZSIsIm5ld1Bhc3N3b3JkIiwicHJvbWlzZXMiLCJjb21wYXJlIiwiY2F0Y2giLCJlcnIiLCJwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsIiwidmVyaWZ5VXNlckVtYWlscyIsImNyZWF0ZVNlc3Npb25Ub2tlbiIsImluc3RhbGxhdGlvbklkIiwic2Vzc2lvbkRhdGEiLCJjcmVhdGVTZXNzaW9uIiwiY3JlYXRlZFdpdGgiLCJhY3Rpb24iLCJhdXRoUHJvdmlkZXIiLCJhZGRPcHMiLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJhc3NpZ24iLCJkZXN0cm95IiwicmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCIsInNlc3Npb25RdWVyeSIsImJpbmQiLCJzZW5kVmVyaWZpY2F0aW9uRW1haWwiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCJhZGRpdGlvbmFsU2Vzc2lvbkRhdGEiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJzdGF0dXMiLCJkZXZpY2VUb2tlbiIsInRvTG93ZXJDYXNlIiwiZGV2aWNlVHlwZSIsImlkTWF0Y2giLCJvYmplY3RJZE1hdGNoIiwiaW5zdGFsbGF0aW9uSWRNYXRjaCIsImRldmljZVRva2VuTWF0Y2hlcyIsIm9yUXVlcmllcyIsImRlbFF1ZXJ5IiwiYXBwSWRlbnRpZmllciIsImNvZGUiLCJvYmpJZCIsImZpbGVzQ29udHJvbGxlciIsImV4cGFuZEZpbGVzSW5PYmplY3QiLCJyb2xlIiwiY2xlYXIiLCJpc1VuYXV0aGVudGljYXRlZCIsIlNFU1NJT05fTUlTU0lORyIsImRvd25sb2FkIiwiZG93bmxvYWROYW1lIiwibmFtZSIsIklOVkFMSURfQUNMIiwicmVhZCIsIndyaXRlIiwibWF4UGFzc3dvcmRBZ2UiLCJfcGFzc3dvcmRfY2hhbmdlZF9hdCIsImRlZmVyIiwiTWF0aCIsIm1heCIsInNoaWZ0IiwiX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEiLCJEVVBMSUNBVEVfVkFMVUUiLCJ1c2VySW5mbyIsImR1cGxpY2F0ZWRfZmllbGQiLCJoYXNBZnRlclNhdmVIb29rIiwiYWZ0ZXJTYXZlIiwiaGFzTGl2ZVF1ZXJ5IiwibGl2ZVF1ZXJ5Q29udHJvbGxlciIsIl9oYW5kbGVTYXZlUmVzcG9uc2UiLCJwZXJtcyIsImdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsIm9uQWZ0ZXJTYXZlIiwibG9nZ2VyIiwid2FybiIsIm1pZGRsZSIsIm1vdW50Iiwic2FuaXRpemVkRGF0YSIsInRlc3QiLCJfZGVjb2RlIiwic3BsaXR0ZWRLZXkiLCJzcGxpdCIsInBhcmVudFByb3AiLCJwYXJlbnRWYWwiLCJnZXQiLCJzZXQiLCJjbGllbnRTdXBwb3J0c0RlbGV0ZSIsInN1cHBvcnRzRm9yd2FyZERlbGV0ZSIsImRhdGFWYWx1ZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFhQTs7QUFDQTs7QUFDQTs7OztBQWZBO0FBQ0E7QUFDQTtBQUVBLElBQUlBLGdCQUFnQixHQUFHQyxPQUFPLENBQUMsZ0NBQUQsQ0FBOUI7O0FBQ0EsSUFBSUMsUUFBUSxHQUFHRCxPQUFPLENBQUMsVUFBRCxDQUF0Qjs7QUFFQSxNQUFNRSxJQUFJLEdBQUdGLE9BQU8sQ0FBQyxRQUFELENBQXBCOztBQUNBLElBQUlHLFdBQVcsR0FBR0gsT0FBTyxDQUFDLGVBQUQsQ0FBekI7O0FBQ0EsSUFBSUksY0FBYyxHQUFHSixPQUFPLENBQUMsWUFBRCxDQUE1Qjs7QUFDQSxJQUFJSyxLQUFLLEdBQUdMLE9BQU8sQ0FBQyxZQUFELENBQW5COztBQUNBLElB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Q0FBQ2MsTUFBTSxDQUFDbkYsU0FBUCxDQUFpQjRQLGNBQWpCLENBQWdDQyxJQUFoQyxDQUFxQ25RLFFBQXJDLEVBQStDMkUsU0FBL0MsQ0FBTCxFQUFnRTtBQUM5RDNFLE1BQUFBLFFBQVEsQ0FBQzJFLFNBQUQsQ0FBUixHQUFzQnNMLFNBQXRCO0FBQ0QsS0FMc0QsQ0FPdkQ7OztBQUNBLFFBQUlqUSxRQUFRLENBQUMyRSxTQUFELENBQVIsSUFBdUIzRSxRQUFRLENBQUMyRSxTQUFELENBQVIsQ0FBb0JHLElBQS9DLEVBQXFEO0FBQ25ELGFBQU85RSxRQUFRLENBQUMyRSxTQUFELENBQWY7O0FBQ0EsVUFBSW9MLG9CQUFvQixJQUFJRSxTQUFTLENBQUNuTCxJQUFWLElBQWtCLFFBQTlDLEVBQXdEO0FBQ3REOUUsUUFBQUEsUUFBUSxDQUFDMkUsU0FBRCxDQUFSLEdBQXNCc0wsU0FBdEI7QUFDRDtBQUNGO0FBQ0YsR0FkRDtBQWVBLFNBQU9qUSxRQUFQO0FBQ0QsQ0FyQkQ7O2VBdUJlakIsUzs7QUFDZnFSLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnRSLFNBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQSBSZXN0V3JpdGUgZW5jYXBzdWxhdGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCB0byBydW4gYW4gb3BlcmF0aW9uXG4vLyB0aGF0IHdyaXRlcyB0byB0aGUgZGF0YWJhc2UuXG4vLyBUaGlzIGNvdWxkIGJlIGVpdGhlciBhIFwiY3JlYXRlXCIgb3IgYW4gXCJ1cGRhdGVcIi5cblxudmFyIFNjaGVtYUNvbnRyb2xsZXIgPSByZXF1aXJlKCcuL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXInKTtcbnZhciBkZWVwY29weSA9IHJlcXVpcmUoJ2RlZXBjb3B5Jyk7XG5cbmNvbnN0IEF1dGggPSByZXF1aXJlKCcuL0F1dGgnKTtcbnZhciBjcnlwdG9VdGlscyA9IHJlcXVpcmUoJy4vY3J5cHRvVXRpbHMnKTtcbnZhciBwYXNzd29yZENyeXB0byA9IHJlcXVpcmUoJy4vcGFzc3dvcmQnKTtcbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKTtcbnZhciB0cmlnZ2VycyA9IHJlcXVpcmUoJy4vdHJpZ2dlcnMnKTtcbnZhciBDbGllbnRTREsgPSByZXF1aXJlKCcuL0NsaWVudFNESycpO1xuaW1wb3J0IFJlc3RRdWVyeSBmcm9tICcuL1Jlc3RRdWVyeSc7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IGxvZ2dlciBmcm9tICcuL2xvZ2dlcic7XG5cbi8vIHF1ZXJ5IGFuZCBkYXRhIGFyZSBib3RoIHByb3ZpZGVkIGluIFJFU1QgQVBJIGZvcm1hdC4gU28gZGF0YVxuLy8gdHlwZXMgYXJlIGVuY29kZWQgYnkgcGxhaW4gb2xkIG9iamVjdHMuXG4vLyBJZiBxdWVyeSBpcyBudWxsLCB0aGlzIGlzIGEgXCJjcmVhdGVcIiBhbmQgdGhlIGRhdGEgaW4gZGF0YSBzaG91bGQgYmVcbi8vIGNyZWF0ZWQuXG4vLyBPdGhlcndpc2UgdGhpcyBpcyBhbiBcInVwZGF0ZVwiIC0gdGhlIG9iamVjdCBtYXRjaGluZyB0aGUgcXVlcnlcbi8vIHNob3VsZCBnZXQgdXBkYXRlZCB3aXRoIGRhdGEuXG4vLyBSZXN0V3JpdGUgd2lsbCBoYW5kbGUgb2JqZWN0SWQsIGNyZWF0ZWRBdCwgYW5kIHVwZGF0ZWRBdCBmb3Jcbi8vIGV2ZXJ5dGhpbmcuIEl0IGFsc28ga25vd3MgdG8gdXNlIHRyaWdnZXJzIGFuZCBzcGVjaWFsIG1vZGlmaWNhdGlvbnNcbi8vIGZvciB0aGUgX1VzZXIgY2xhc3MuXG5mdW5jdGlvbiBSZXN0V3JpdGUoXG4gIGNvbmZpZyxcbiAgYXV0aCxcbiAgY2xhc3NOYW1lLFxuICBxdWVyeSxcbiAgZGF0YSxcbiAgb3JpZ2luYWxEYXRhLFxuICBjbGllbnRTREtcbikge1xuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICdDYW5ub3QgcGVyZm9ybSBhIHdyaXRlIG9wZXJhdGlvbiB3aGVuIHVzaW5nIHJlYWRPbmx5TWFzdGVyS2V5J1xuICAgICk7XG4gIH1cbiAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gIHRoaXMuYXV0aCA9IGF1dGg7XG4gIHRoaXMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB0aGlzLmNsaWVudFNESyA9IGNsaWVudFNESztcbiAgdGhpcy5zdG9yYWdlID0ge307XG4gIHRoaXMucnVuT3B0aW9ucyA9IHt9O1xuICB0aGlzLmNvbnRleHQgPSB7fTtcbiAgaWYgKCFxdWVyeSAmJiBkYXRhLm9iamVjdElkKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSxcbiAgICAgICdvYmplY3RJZCBpcyBhbiBpbnZhbGlkIGZpZWxkIG5hbWUuJ1xuICAgICk7XG4gIH1cbiAgaWYgKCFxdWVyeSAmJiBkYXRhLmlkKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSxcbiAgICAgICdpZCBpcyBhbiBpbnZhbGlkIGZpZWxkIG5hbWUuJ1xuICAgICk7XG4gIH1cblxuICAvLyBXaGVuIHRoZSBvcGVyYXRpb24gaXMgY29tcGxldGUsIHRoaXMucmVzcG9uc2UgbWF5IGhhdmUgc2V2ZXJhbFxuICAvLyBmaWVsZHMuXG4gIC8vIHJlc3BvbnNlOiB0aGUgYWN0dWFsIGRhdGEgdG8gYmUgcmV0dXJuZWRcbiAgLy8gc3RhdHVzOiB0aGUgaHR0cCBzdGF0dXMgY29kZS4gaWYgbm90IHByZXNlbnQsIHRyZWF0ZWQgbGlrZSBhIDIwMFxuICAvLyBsb2NhdGlvbjogdGhlIGxvY2F0aW9uIGhlYWRlci4gaWYgbm90IHByZXNlbnQsIG5vIGxvY2F0aW9uIGhlYWRlclxuICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcblxuICAvLyBQcm9jZXNzaW5nIHRoaXMgb3BlcmF0aW9uIG1heSBtdXRhdGUgb3VyIGRhdGEsIHNvIHdlIG9wZXJhdGUgb24gYVxuICAvLyBjb3B5XG4gIHRoaXMucXVlcnkgPSBkZWVwY29weShxdWVyeSk7XG4gIHRoaXMuZGF0YSA9IGRlZXBjb3B5KGRhdGEpO1xuICAvLyBXZSBuZXZlciBjaGFuZ2Ugb3JpZ2luYWxEYXRhLCBzbyB3ZSBkbyBub3QgbmVlZCBhIGRlZXAgY29weVxuICB0aGlzLm9yaWdpbmFsRGF0YSA9IG9yaWdpbmFsRGF0YTtcblxuICAvLyBUaGUgdGltZXN0YW1wIHdlJ2xsIHVzZSBmb3IgdGhpcyB3aG9sZSBvcGVyYXRpb25cbiAgdGhpcy51cGRhdGVkQXQgPSBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKCkpLmlzbztcblxuICAvLyBTaGFyZWQgU2NoZW1hQ29udHJvbGxlciB0byBiZSByZXVzZWQgdG8gcmVkdWNlIHRoZSBudW1iZXIgb2YgbG9hZFNjaGVtYSgpIGNhbGxzIHBlciByZXF1ZXN0XG4gIC8vIE9uY2Ugc2V0IHRoZSBzY2hlbWFEYXRhIHNob3VsZCBiZSBpbW11dGFibGVcbiAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIgPSBudWxsO1xufVxuXG4vLyBBIGNvbnZlbmllbnQgbWV0aG9kIHRvIHBlcmZvcm0gYWxsIHRoZSBzdGVwcyBvZiBwcm9jZXNzaW5nIHRoZVxuLy8gd3JpdGUsIGluIG9yZGVyLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIGEge3Jlc3BvbnNlLCBzdGF0dXMsIGxvY2F0aW9ufSBvYmplY3QuXG4vLyBzdGF0dXMgYW5kIGxvY2F0aW9uIGFyZSBvcHRpb25hbC5cblJlc3RXcml0ZS5wcm90b3R5cGUuZXhlY3V0ZSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5nZXRVc2VyQW5kUm9sZUFDTCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVJbnN0YWxsYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZVNlc3Npb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQXV0aERhdGEoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkJlZm9yZVNhdmVUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5kZWxldGVFbWFpbFJlc2V0VG9rZW5JZk5lZWRlZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVTY2hlbWEoKTtcbiAgICB9KVxuICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIgPSBzY2hlbWFDb250cm9sbGVyO1xuICAgICAgcmV0dXJuIHRoaXMuc2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudHJhbnNmb3JtVXNlcigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkRhdGFiYXNlT3BlcmF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlRm9sbG93dXAoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkFmdGVyU2F2ZVRyaWdnZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNsZWFuVXNlckF1dGhEYXRhKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXNwb25zZTtcbiAgICB9KTtcbn07XG5cbi8vIFVzZXMgdGhlIEF1dGggb2JqZWN0IHRvIGdldCB0aGUgbGlzdCBvZiByb2xlcywgYWRkcyB0aGUgdXNlciBpZFxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VyQW5kUm9sZUFDTCA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IFsnKiddO1xuXG4gIGlmICh0aGlzLmF1dGgudXNlcikge1xuICAgIHJldHVybiB0aGlzLmF1dGguZ2V0VXNlclJvbGVzKCkudGhlbihyb2xlcyA9PiB7XG4gICAgICB0aGlzLnJ1bk9wdGlvbnMuYWNsID0gdGhpcy5ydW5PcHRpb25zLmFjbC5jb25jYXQocm9sZXMsIFtcbiAgICAgICAgdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICBdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbigpIHtcbiAgaWYgKFxuICAgIHRoaXMuY29uZmlnLmFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiA9PT0gZmFsc2UgJiZcbiAgICAhdGhpcy5hdXRoLmlzTWFzdGVyICYmXG4gICAgU2NoZW1hQ29udHJvbGxlci5zeXN0ZW1DbGFzc2VzLmluZGV4T2YodGhpcy5jbGFzc05hbWUpID09PSAtMVxuICApIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5sb2FkU2NoZW1hKClcbiAgICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5oYXNDbGFzcyh0aGlzLmNsYXNzTmFtZSkpXG4gICAgICAudGhlbihoYXNDbGFzcyA9PiB7XG4gICAgICAgIGlmIChoYXNDbGFzcyAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICAnVGhpcyB1c2VyIGlzIG5vdCBhbGxvd2VkIHRvIGFjY2VzcyAnICtcbiAgICAgICAgICAgICAgJ25vbi1leGlzdGVudCBjbGFzczogJyArXG4gICAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgc2NoZW1hLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZVNjaGVtYSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UudmFsaWRhdGVPYmplY3QoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdGhpcy5kYXRhLFxuICAgIHRoaXMucXVlcnksXG4gICAgdGhpcy5ydW5PcHRpb25zXG4gICk7XG59O1xuXG4vLyBSdW5zIGFueSBiZWZvcmVTYXZlIHRyaWdnZXJzIGFnYWluc3QgdGhpcyBvcGVyYXRpb24uXG4vLyBBbnkgY2hhbmdlIGxlYWRzIHRvIG91ciBkYXRhIGJlaW5nIG11dGF0ZWQuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkJlZm9yZVNhdmVUcmlnZ2VyID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYmVmb3JlU2F2ZScgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgaWYgKFxuICAgICF0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLFxuICAgICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICAgIClcbiAgKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgLy8gQ2xvdWQgY29kZSBnZXRzIGEgYml0IG9mIGV4dHJhIGRhdGEgZm9yIGl0cyBvYmplY3RzXG4gIHZhciBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUgfTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIGV4dHJhRGF0YS5vYmplY3RJZCA9IHRoaXMucXVlcnkub2JqZWN0SWQ7XG4gIH1cblxuICBsZXQgb3JpZ2luYWxPYmplY3QgPSBudWxsO1xuICBjb25zdCB1cGRhdGVkT2JqZWN0ID0gdGhpcy5idWlsZFVwZGF0ZWRPYmplY3QoZXh0cmFEYXRhKTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIC8vIFRoaXMgaXMgYW4gdXBkYXRlIGZvciBleGlzdGluZyBvYmplY3QuXG4gICAgb3JpZ2luYWxPYmplY3QgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdGhpcy5vcmlnaW5hbERhdGEpO1xuICB9XG5cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gQmVmb3JlIGNhbGxpbmcgdGhlIHRyaWdnZXIsIHZhbGlkYXRlIHRoZSBwZXJtaXNzaW9ucyBmb3IgdGhlIHNhdmUgb3BlcmF0aW9uXG4gICAgICBsZXQgZGF0YWJhc2VQcm9taXNlID0gbnVsbDtcbiAgICAgIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIC8vIFZhbGlkYXRlIGZvciB1cGRhdGluZ1xuICAgICAgICBkYXRhYmFzZVByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS51cGRhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5xdWVyeSxcbiAgICAgICAgICB0aGlzLmRhdGEsXG4gICAgICAgICAgdGhpcy5ydW5PcHRpb25zLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFZhbGlkYXRlIGZvciBjcmVhdGluZ1xuICAgICAgICBkYXRhYmFzZVByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS5jcmVhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBJbiB0aGUgY2FzZSB0aGF0IHRoZXJlIGlzIG5vIHBlcm1pc3Npb24gZm9yIHRoZSBvcGVyYXRpb24sIGl0IHRocm93cyBhbiBlcnJvclxuICAgICAgcmV0dXJuIGRhdGFiYXNlUHJvbWlzZS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmICghcmVzdWx0IHx8IHJlc3VsdC5sZW5ndGggPD0gMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAnT2JqZWN0IG5vdCBmb3VuZC4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLFxuICAgICAgICB0aGlzLmF1dGgsXG4gICAgICAgIHVwZGF0ZWRPYmplY3QsXG4gICAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgICB0aGlzLmNvbmZpZyxcbiAgICAgICAgdGhpcy5jb250ZXh0XG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgaWYgKHJlc3BvbnNlICYmIHJlc3BvbnNlLm9iamVjdCkge1xuICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciA9IF8ucmVkdWNlKFxuICAgICAgICAgIHJlc3BvbnNlLm9iamVjdCxcbiAgICAgICAgICAocmVzdWx0LCB2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFcXVhbCh0aGlzLmRhdGFba2V5XSwgdmFsdWUpKSB7XG4gICAgICAgICAgICAgIHJlc3VsdC5wdXNoKGtleSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgIH0sXG4gICAgICAgICAgW11cbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5kYXRhID0gcmVzcG9uc2Uub2JqZWN0O1xuICAgICAgICAvLyBXZSBzaG91bGQgZGVsZXRlIHRoZSBvYmplY3RJZCBmb3IgYW4gdXBkYXRlIHdyaXRlXG4gICAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlciA9IGFzeW5jIGZ1bmN0aW9uKHVzZXJEYXRhKSB7XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2JlZm9yZUxvZ2luJyB0cmlnZ2VyXG4gIGlmIChcbiAgICAhdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlTG9naW4sXG4gICAgICB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkXG4gICAgKVxuICApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBDbG91ZCBjb2RlIGdldHMgYSBiaXQgb2YgZXh0cmEgZGF0YSBmb3IgaXRzIG9iamVjdHNcbiAgY29uc3QgZXh0cmFEYXRhID0geyBjbGFzc05hbWU6IHRoaXMuY2xhc3NOYW1lIH07XG4gIGNvbnN0IHVzZXIgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdXNlckRhdGEpO1xuXG4gIC8vIG5vIG5lZWQgdG8gcmV0dXJuIGEgcmVzcG9uc2VcbiAgYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKFxuICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUxvZ2luLFxuICAgIHRoaXMuYXV0aCxcbiAgICB1c2VyLFxuICAgIG51bGwsXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5jb250ZXh0XG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnNldFJlcXVpcmVkRmllbGRzSWZOZWVkZWQgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuZGF0YSkge1xuICAgIHJldHVybiB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlci5nZXRBbGxDbGFzc2VzKCkudGhlbihhbGxDbGFzc2VzID0+IHtcbiAgICAgIGNvbnN0IHNjaGVtYSA9IGFsbENsYXNzZXMuZmluZChcbiAgICAgICAgb25lQ2xhc3MgPT4gb25lQ2xhc3MuY2xhc3NOYW1lID09PSB0aGlzLmNsYXNzTmFtZVxuICAgICAgKTtcbiAgICAgIGNvbnN0IHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCA9IChmaWVsZE5hbWUsIHNldERlZmF1bHQpID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gbnVsbCB8fFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnJyB8fFxuICAgICAgICAgICh0eXBlb2YgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09ICdvYmplY3QnICYmXG4gICAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXS5fX29wID09PSAnRGVsZXRlJylcbiAgICAgICAgKSB7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgc2V0RGVmYXVsdCAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlICE9PSBudWxsICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgICAgICh0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkIHx8XG4gICAgICAgICAgICAgICh0eXBlb2YgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09ICdvYmplY3QnICYmXG4gICAgICAgICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0uX19vcCA9PT0gJ0RlbGV0ZScpKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlO1xuICAgICAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPVxuICAgICAgICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciB8fCBbXTtcbiAgICAgICAgICAgIGlmICh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5pbmRleE9mKGZpZWxkTmFtZSkgPCAwKSB7XG4gICAgICAgICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucmVxdWlyZWQgPT09IHRydWVcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUixcbiAgICAgICAgICAgICAgYCR7ZmllbGROYW1lfSBpcyByZXF1aXJlZGBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICBjb25zdCBhc3NpZ25PYmplY3RJZCA9ICgpID0+IHtcbiAgICAgICAgY29uc3Qgb2JqZWN0SWQgPSBjcnlwdG9VdGlscy5uZXdPYmplY3RJZChcbiAgICAgICAgICB0aGlzLmNvbmZpZy5vYmplY3RJZFNpemUsXG4gICAgICAgICAgdGhpcy5jb25maWcub2JqZWN0SWRVc2VUaW1lXG4gICAgICAgICk7XG4gICAgICAgIGlmICghdGhpcy5jb25maWcub2JqZWN0SWRQcmVmaXhlcykge1xuICAgICAgICAgIHJldHVybiBvYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcy5jb25maWcub2JqZWN0SWRQcmVmaXhlc1t0aGlzLmNsYXNzTmFtZV1cbiAgICAgICAgICA/IGAke3RoaXMuY29uZmlnLm9iamVjdElkUHJlZml4ZXNbdGhpcy5jbGFzc05hbWVdfSR7b2JqZWN0SWR9YFxuICAgICAgICAgIDogb2JqZWN0SWQ7XG4gICAgICB9O1xuXG4gICAgICAvLyBBZGQgZGVmYXVsdCBmaWVsZHNcbiAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICAgIGlmICghdGhpcy5xdWVyeSkge1xuICAgICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG5cbiAgICAgICAgLy8gT25seSBhc3NpZ24gbmV3IG9iamVjdElkIGlmIHdlIGFyZSBjcmVhdGluZyBuZXcgb2JqZWN0XG4gICAgICAgIGlmICghdGhpcy5kYXRhLm9iamVjdElkKSB7XG4gICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gYXNzaWduT2JqZWN0SWQoKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2NoZW1hKSB7XG4gICAgICAgICAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgc2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkKGZpZWxkTmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoc2NoZW1hKSB7XG4gICAgICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YSkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgIHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZChmaWVsZE5hbWUsIGZhbHNlKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuLy8gVHJhbnNmb3JtcyBhdXRoIGRhdGEgZm9yIGEgdXNlciBvYmplY3QuXG4vLyBEb2VzIG5vdGhpbmcgaWYgdGhpcyBpc24ndCBhIHVzZXIgb2JqZWN0LlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUF1dGhEYXRhID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgaWYgKFxuICAgICAgdHlwZW9mIHRoaXMuZGF0YS51c2VybmFtZSAhPT0gJ3N0cmluZycgfHxcbiAgICAgIF8uaXNFbXB0eSh0aGlzLmRhdGEudXNlcm5hbWUpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX01JU1NJTkcsXG4gICAgICAgICdiYWQgb3IgbWlzc2luZyB1c2VybmFtZSdcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIHR5cGVvZiB0aGlzLmRhdGEucGFzc3dvcmQgIT09ICdzdHJpbmcnIHx8XG4gICAgICBfLmlzRW1wdHkodGhpcy5kYXRhLnBhc3N3b3JkKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5QQVNTV09SRF9NSVNTSU5HLFxuICAgICAgICAncGFzc3dvcmQgaXMgcmVxdWlyZWQnXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGlmICghdGhpcy5kYXRhLmF1dGhEYXRhIHx8ICFPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBhdXRoRGF0YSA9IHRoaXMuZGF0YS5hdXRoRGF0YTtcbiAgdmFyIHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgaWYgKHByb3ZpZGVycy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY2FuSGFuZGxlQXV0aERhdGEgPSBwcm92aWRlcnMucmVkdWNlKChjYW5IYW5kbGUsIHByb3ZpZGVyKSA9PiB7XG4gICAgICB2YXIgcHJvdmlkZXJBdXRoRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgIHZhciBoYXNUb2tlbiA9IHByb3ZpZGVyQXV0aERhdGEgJiYgcHJvdmlkZXJBdXRoRGF0YS5pZDtcbiAgICAgIHJldHVybiBjYW5IYW5kbGUgJiYgKGhhc1Rva2VuIHx8IHByb3ZpZGVyQXV0aERhdGEgPT0gbnVsbCk7XG4gICAgfSwgdHJ1ZSk7XG4gICAgaWYgKGNhbkhhbmRsZUF1dGhEYXRhKSB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoRGF0YShhdXRoRGF0YSk7XG4gICAgfVxuICB9XG4gIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiA9IGZ1bmN0aW9uKGF1dGhEYXRhKSB7XG4gIGNvbnN0IHZhbGlkYXRpb25zID0gT2JqZWN0LmtleXMoYXV0aERhdGEpLm1hcChwcm92aWRlciA9PiB7XG4gICAgaWYgKGF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICBjb25zdCB2YWxpZGF0ZUF1dGhEYXRhID0gdGhpcy5jb25maWcuYXV0aERhdGFNYW5hZ2VyLmdldFZhbGlkYXRvckZvclByb3ZpZGVyKFxuICAgICAgcHJvdmlkZXJcbiAgICApO1xuICAgIGlmICghdmFsaWRhdGVBdXRoRGF0YSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICAgICAnVGhpcyBhdXRoZW50aWNhdGlvbiBtZXRob2QgaXMgdW5zdXBwb3J0ZWQuJ1xuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbGlkYXRlQXV0aERhdGEoYXV0aERhdGFbcHJvdmlkZXJdKTtcbiAgfSk7XG4gIHJldHVybiBQcm9taXNlLmFsbCh2YWxpZGF0aW9ucyk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbmRVc2Vyc1dpdGhBdXRoRGF0YSA9IGZ1bmN0aW9uKGF1dGhEYXRhKSB7XG4gIGNvbnN0IHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgY29uc3QgcXVlcnkgPSBwcm92aWRlcnNcbiAgICAucmVkdWNlKChtZW1vLCBwcm92aWRlcikgPT4ge1xuICAgICAgaWYgKCFhdXRoRGF0YVtwcm92aWRlcl0pIHtcbiAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICB9XG4gICAgICBjb25zdCBxdWVyeUtleSA9IGBhdXRoRGF0YS4ke3Byb3ZpZGVyfS5pZGA7XG4gICAgICBjb25zdCBxdWVyeSA9IHt9O1xuICAgICAgcXVlcnlbcXVlcnlLZXldID0gYXV0aERhdGFbcHJvdmlkZXJdLmlkO1xuICAgICAgbWVtby5wdXNoKHF1ZXJ5KTtcbiAgICAgIHJldHVybiBtZW1vO1xuICAgIH0sIFtdKVxuICAgIC5maWx0ZXIocSA9PiB7XG4gICAgICByZXR1cm4gdHlwZW9mIHEgIT09ICd1bmRlZmluZWQnO1xuICAgIH0pO1xuXG4gIGxldCBmaW5kUHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZShbXSk7XG4gIGlmIChxdWVyeS5sZW5ndGggPiAwKSB7XG4gICAgZmluZFByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKHRoaXMuY2xhc3NOYW1lLCB7ICRvcjogcXVlcnkgfSwge30pO1xuICB9XG5cbiAgcmV0dXJuIGZpbmRQcm9taXNlO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5maWx0ZXJlZE9iamVjdHNCeUFDTCA9IGZ1bmN0aW9uKG9iamVjdHMpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHJldHVybiBvYmplY3RzO1xuICB9XG4gIHJldHVybiBvYmplY3RzLmZpbHRlcihvYmplY3QgPT4ge1xuICAgIGlmICghb2JqZWN0LkFDTCkge1xuICAgICAgcmV0dXJuIHRydWU7IC8vIGxlZ2FjeSB1c2VycyB0aGF0IGhhdmUgbm8gQUNMIGZpZWxkIG9uIHRoZW1cbiAgICB9XG4gICAgLy8gUmVndWxhciB1c2VycyB0aGF0IGhhdmUgYmVlbiBsb2NrZWQgb3V0LlxuICAgIHJldHVybiBvYmplY3QuQUNMICYmIE9iamVjdC5rZXlzKG9iamVjdC5BQ0wpLmxlbmd0aCA+IDA7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVBdXRoRGF0YSA9IGZ1bmN0aW9uKGF1dGhEYXRhKSB7XG4gIGxldCByZXN1bHRzO1xuICByZXR1cm4gdGhpcy5maW5kVXNlcnNXaXRoQXV0aERhdGEoYXV0aERhdGEpLnRoZW4oYXN5bmMgciA9PiB7XG4gICAgcmVzdWx0cyA9IHRoaXMuZmlsdGVyZWRPYmplY3RzQnlBQ0wocik7XG5cbiAgICBpZiAocmVzdWx0cy5sZW5ndGggPT0gMSkge1xuICAgICAgdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKS5qb2luKCcsJyk7XG5cbiAgICAgIGNvbnN0IHVzZXJSZXN1bHQgPSByZXN1bHRzWzBdO1xuICAgICAgY29uc3QgbXV0YXRlZEF1dGhEYXRhID0ge307XG4gICAgICBPYmplY3Qua2V5cyhhdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgIGNvbnN0IHByb3ZpZGVyRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgY29uc3QgdXNlckF1dGhEYXRhID0gdXNlclJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICAgIGlmICghXy5pc0VxdWFsKHByb3ZpZGVyRGF0YSwgdXNlckF1dGhEYXRhKSkge1xuICAgICAgICAgIG11dGF0ZWRBdXRoRGF0YVtwcm92aWRlcl0gPSBwcm92aWRlckRhdGE7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFzTXV0YXRlZEF1dGhEYXRhID0gT2JqZWN0LmtleXMobXV0YXRlZEF1dGhEYXRhKS5sZW5ndGggIT09IDA7XG4gICAgICBsZXQgdXNlcklkO1xuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICB1c2VySWQgPSB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICAgICAgfSBlbHNlIGlmICh0aGlzLmF1dGggJiYgdGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICAgICAgdXNlcklkID0gdGhpcy5hdXRoLnVzZXIuaWQ7XG4gICAgICB9XG4gICAgICBpZiAoIXVzZXJJZCB8fCB1c2VySWQgPT09IHVzZXJSZXN1bHQub2JqZWN0SWQpIHtcbiAgICAgICAgLy8gbm8gdXNlciBtYWtpbmcgdGhlIGNhbGxcbiAgICAgICAgLy8gT1IgdGhlIHVzZXIgbWFraW5nIHRoZSBjYWxsIGlzIHRoZSByaWdodCBvbmVcbiAgICAgICAgLy8gTG9naW4gd2l0aCBhdXRoIGRhdGFcbiAgICAgICAgZGVsZXRlIHJlc3VsdHNbMF0ucGFzc3dvcmQ7XG5cbiAgICAgICAgLy8gbmVlZCB0byBzZXQgdGhlIG9iamVjdElkIGZpcnN0IG90aGVyd2lzZSBsb2NhdGlvbiBoYXMgdHJhaWxpbmcgdW5kZWZpbmVkXG4gICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCA9IHVzZXJSZXN1bHQub2JqZWN0SWQ7XG5cbiAgICAgICAgaWYgKCF0aGlzLnF1ZXJ5IHx8ICF0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgLy8gdGhpcyBhIGxvZ2luIGNhbGwsIG5vIHVzZXJJZCBwYXNzZWRcbiAgICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgICAgcmVzcG9uc2U6IHVzZXJSZXN1bHQsXG4gICAgICAgICAgICBsb2NhdGlvbjogdGhpcy5sb2NhdGlvbigpLFxuICAgICAgICAgIH07XG4gICAgICAgICAgLy8gUnVuIGJlZm9yZUxvZ2luIGhvb2sgYmVmb3JlIHN0b3JpbmcgYW55IHVwZGF0ZXNcbiAgICAgICAgICAvLyB0byBhdXRoRGF0YSBvbiB0aGUgZGI7IGNoYW5nZXMgdG8gdXNlclJlc3VsdFxuICAgICAgICAgIC8vIHdpbGwgYmUgaWdub3JlZC5cbiAgICAgICAgICBhd2FpdCB0aGlzLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlcihkZWVwY29weSh1c2VyUmVzdWx0KSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB3ZSBkaWRuJ3QgY2hhbmdlIHRoZSBhdXRoIGRhdGEsIGp1c3Qga2VlcCBnb2luZ1xuICAgICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICAvLyBXZSBoYXZlIGF1dGhEYXRhIHRoYXQgaXMgdXBkYXRlZCBvbiBsb2dpblxuICAgICAgICAvLyB0aGF0IGNhbiBoYXBwZW4gd2hlbiB0b2tlbiBhcmUgcmVmcmVzaGVkLFxuICAgICAgICAvLyBXZSBzaG91bGQgdXBkYXRlIHRoZSB0b2tlbiBhbmQgbGV0IHRoZSB1c2VyIGluXG4gICAgICAgIC8vIFdlIHNob3VsZCBvbmx5IGNoZWNrIHRoZSBtdXRhdGVkIGtleXNcbiAgICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKG11dGF0ZWRBdXRoRGF0YSkudGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgICAgLy8gSUYgd2UgaGF2ZSBhIHJlc3BvbnNlLCB3ZSdsbCBza2lwIHRoZSBkYXRhYmFzZSBvcGVyYXRpb24gLyBiZWZvcmVTYXZlIC8gYWZ0ZXJTYXZlIGV0Yy4uLlxuICAgICAgICAgIC8vIHdlIG5lZWQgdG8gc2V0IGl0IHVwIHRoZXJlLlxuICAgICAgICAgIC8vIFdlIGFyZSBzdXBwb3NlZCB0byBoYXZlIGEgcmVzcG9uc2Ugb25seSBvbiBMT0dJTiB3aXRoIGF1dGhEYXRhLCBzbyB3ZSBza2lwIHRob3NlXG4gICAgICAgICAgLy8gSWYgd2UncmUgbm90IGxvZ2dpbmcgaW4sIGJ1dCBqdXN0IHVwZGF0aW5nIHRoZSBjdXJyZW50IHVzZXIsIHdlIGNhbiBzYWZlbHkgc2tpcCB0aGF0IHBhcnRcbiAgICAgICAgICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgICAgICAgICAgLy8gQXNzaWduIHRoZSBuZXcgYXV0aERhdGEgaW4gdGhlIHJlc3BvbnNlXG4gICAgICAgICAgICBPYmplY3Qua2V5cyhtdXRhdGVkQXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLmF1dGhEYXRhW3Byb3ZpZGVyXSA9XG4gICAgICAgICAgICAgICAgbXV0YXRlZEF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBSdW4gdGhlIERCIHVwZGF0ZSBkaXJlY3RseSwgYXMgJ21hc3RlcidcbiAgICAgICAgICAgIC8vIEp1c3QgdXBkYXRlIHRoZSBhdXRoRGF0YSBwYXJ0XG4gICAgICAgICAgICAvLyBUaGVuIHdlJ3JlIGdvb2QgZm9yIHRoZSB1c2VyLCBlYXJseSBleGl0IG9mIHNvcnRzXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgeyBvYmplY3RJZDogdGhpcy5kYXRhLm9iamVjdElkIH0sXG4gICAgICAgICAgICAgIHsgYXV0aERhdGE6IG11dGF0ZWRBdXRoRGF0YSB9LFxuICAgICAgICAgICAgICB7fVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmICh1c2VySWQpIHtcbiAgICAgICAgLy8gVHJ5aW5nIHRvIHVwZGF0ZSBhdXRoIGRhdGEgYnV0IHVzZXJzXG4gICAgICAgIC8vIGFyZSBkaWZmZXJlbnRcbiAgICAgICAgaWYgKHVzZXJSZXN1bHQub2JqZWN0SWQgIT09IHVzZXJJZCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsXG4gICAgICAgICAgICAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCdcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIE5vIGF1dGggZGF0YSB3YXMgbXV0YXRlZCwganVzdCBrZWVwIGdvaW5nXG4gICAgICAgIGlmICghaGFzTXV0YXRlZEF1dGhEYXRhKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihhdXRoRGF0YSkudGhlbigoKSA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIC8vIE1vcmUgdGhhbiAxIHVzZXIgd2l0aCB0aGUgcGFzc2VkIGlkJ3NcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsXG4gICAgICAgICAgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufTtcblxuLy8gVGhlIG5vbi10aGlyZC1wYXJ0eSBwYXJ0cyBvZiBVc2VyIHRyYW5zZm9ybWF0aW9uXG5SZXN0V3JpdGUucHJvdG90eXBlLnRyYW5zZm9ybVVzZXIgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyICYmICdlbWFpbFZlcmlmaWVkJyBpbiB0aGlzLmRhdGEpIHtcbiAgICBjb25zdCBlcnJvciA9IGBDbGllbnRzIGFyZW4ndCBhbGxvd2VkIHRvIG1hbnVhbGx5IHVwZGF0ZSBlbWFpbCB2ZXJpZmljYXRpb24uYDtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTiwgZXJyb3IpO1xuICB9XG5cbiAgLy8gRG8gbm90IGNsZWFudXAgc2Vzc2lvbiBpZiBvYmplY3RJZCBpcyBub3Qgc2V0XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMub2JqZWN0SWQoKSkge1xuICAgIC8vIElmIHdlJ3JlIHVwZGF0aW5nIGEgX1VzZXIgb2JqZWN0LCB3ZSBuZWVkIHRvIGNsZWFyIG91dCB0aGUgY2FjaGUgZm9yIHRoYXQgdXNlci4gRmluZCBhbGwgdGhlaXJcbiAgICAvLyBzZXNzaW9uIHRva2VucywgYW5kIHJlbW92ZSB0aGVtIGZyb20gdGhlIGNhY2hlLlxuICAgIHByb21pc2UgPSBuZXcgUmVzdFF1ZXJ5KHRoaXMuY29uZmlnLCBBdXRoLm1hc3Rlcih0aGlzLmNvbmZpZyksICdfU2Vzc2lvbicsIHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICAgIH0sXG4gICAgfSlcbiAgICAgIC5leGVjdXRlKClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICByZXN1bHRzLnJlc3VsdHMuZm9yRWFjaChzZXNzaW9uID0+XG4gICAgICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnVzZXIuZGVsKHNlc3Npb24uc2Vzc2lvblRva2VuKVxuICAgICAgICApO1xuICAgICAgfSk7XG4gIH1cblxuICByZXR1cm4gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIFRyYW5zZm9ybSB0aGUgcGFzc3dvcmRcbiAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBpZ25vcmUgb25seSBpZiB1bmRlZmluZWQuIHNob3VsZCBwcm9jZWVkIGlmIGVtcHR5ICgnJylcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSA9IHRydWU7XG4gICAgICAgIC8vIEdlbmVyYXRlIGEgbmV3IHNlc3Npb24gb25seSBpZiB0aGUgdXNlciByZXF1ZXN0ZWRcbiAgICAgICAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICAgICAgICB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uaGFzaCh0aGlzLmRhdGEucGFzc3dvcmQpLnRoZW4oaGFzaGVkUGFzc3dvcmQgPT4ge1xuICAgICAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkID0gaGFzaGVkUGFzc3dvcmQ7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVVzZXJOYW1lKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVFbWFpbCgpO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVVc2VyTmFtZSA9IGZ1bmN0aW9uKCkge1xuICAvLyBDaGVjayBmb3IgdXNlcm5hbWUgdW5pcXVlbmVzc1xuICBpZiAoIXRoaXMuZGF0YS51c2VybmFtZSkge1xuICAgIGlmICghdGhpcy5xdWVyeSkge1xuICAgICAgdGhpcy5kYXRhLnVzZXJuYW1lID0gY3J5cHRvVXRpbHMucmFuZG9tU3RyaW5nKDI1KTtcbiAgICAgIHRoaXMucmVzcG9uc2VTaG91bGRIYXZlVXNlcm5hbWUgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gV2UgbmVlZCB0byBhIGZpbmQgdG8gY2hlY2sgZm9yIGR1cGxpY2F0ZSB1c2VybmFtZSBpbiBjYXNlIHRoZXkgYXJlIG1pc3NpbmcgdGhlIHVuaXF1ZSBpbmRleCBvbiB1c2VybmFtZXNcbiAgLy8gVE9ETzogQ2hlY2sgaWYgdGhlcmUgaXMgYSB1bmlxdWUgaW5kZXgsIGFuZCBpZiBzbywgc2tpcCB0aGlzIHF1ZXJ5LlxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZChcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgeyB1c2VybmFtZTogdGhpcy5kYXRhLnVzZXJuYW1lLCBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9IH0sXG4gICAgICB7IGxpbWl0OiAxIH0sXG4gICAgICB7fSxcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfVEFLRU4sXG4gICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVFbWFpbCA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMuZGF0YS5lbWFpbCB8fCB0aGlzLmRhdGEuZW1haWwuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gVmFsaWRhdGUgYmFzaWMgZW1haWwgYWRkcmVzcyBmb3JtYXRcbiAgaWYgKCF0aGlzLmRhdGEuZW1haWwubWF0Y2goL14uK0AuKyQvKSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9FTUFJTF9BRERSRVNTLFxuICAgICAgICAnRW1haWwgYWRkcmVzcyBmb3JtYXQgaXMgaW52YWxpZC4nXG4gICAgICApXG4gICAgKTtcbiAgfVxuICAvLyBTYW1lIHByb2JsZW0gZm9yIGVtYWlsIGFzIGFib3ZlIGZvciB1c2VybmFtZVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZChcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgeyBlbWFpbDogdGhpcy5kYXRhLmVtYWlsLCBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9IH0sXG4gICAgICB7IGxpbWl0OiAxIH0sXG4gICAgICB7fSxcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgICF0aGlzLmRhdGEuYXV0aERhdGEgfHxcbiAgICAgICAgIU9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoIHx8XG4gICAgICAgIChPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCA9PT0gMSAmJlxuICAgICAgICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSlbMF0gPT09ICdhbm9ueW1vdXMnKVxuICAgICAgKSB7XG4gICAgICAgIC8vIFdlIHVwZGF0ZWQgdGhlIGVtYWlsLCBzZW5kIGEgbmV3IHZhbGlkYXRpb25cbiAgICAgICAgdGhpcy5zdG9yYWdlWydzZW5kVmVyaWZpY2F0aW9uRW1haWwnXSA9IHRydWU7XG4gICAgICAgIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNldEVtYWlsVmVyaWZ5VG9rZW4odGhpcy5kYXRhKTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cygpLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSgpO1xuICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMgPSBmdW5jdGlvbigpIHtcbiAgLy8gY2hlY2sgaWYgdGhlIHBhc3N3b3JkIGNvbmZvcm1zIHRvIHRoZSBkZWZpbmVkIHBhc3N3b3JkIHBvbGljeSBpZiBjb25maWd1cmVkXG4gIC8vIElmIHdlIHNwZWNpZmllZCBhIGN1c3RvbSBlcnJvciBpbiBvdXIgY29uZmlndXJhdGlvbiB1c2UgaXQuXG4gIC8vIEV4YW1wbGU6IFwiUGFzc3dvcmRzIG11c3QgaW5jbHVkZSBhIENhcGl0YWwgTGV0dGVyLCBMb3dlcmNhc2UgTGV0dGVyLCBhbmQgYSBudW1iZXIuXCJcbiAgLy9cbiAgLy8gVGhpcyBpcyBlc3BlY2lhbGx5IHVzZWZ1bCBvbiB0aGUgZ2VuZXJpYyBcInBhc3N3b3JkIHJlc2V0XCIgcGFnZSxcbiAgLy8gYXMgaXQgYWxsb3dzIHRoZSBwcm9ncmFtbWVyIHRvIGNvbW11bmljYXRlIHNwZWNpZmljIHJlcXVpcmVtZW50cyBpbnN0ZWFkIG9mOlxuICAvLyBhLiBtYWtpbmcgdGhlIHVzZXIgZ3Vlc3Mgd2hhdHMgd3JvbmdcbiAgLy8gYi4gbWFraW5nIGEgY3VzdG9tIHBhc3N3b3JkIHJlc2V0IHBhZ2UgdGhhdCBzaG93cyB0aGUgcmVxdWlyZW1lbnRzXG4gIGNvbnN0IHBvbGljeUVycm9yID0gdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdGlvbkVycm9yXG4gICAgPyB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0aW9uRXJyb3JcbiAgICA6ICdQYXNzd29yZCBkb2VzIG5vdCBtZWV0IHRoZSBQYXNzd29yZCBQb2xpY3kgcmVxdWlyZW1lbnRzLic7XG4gIGNvbnN0IGNvbnRhaW5zVXNlcm5hbWVFcnJvciA9ICdQYXNzd29yZCBjYW5ub3QgY29udGFpbiB5b3VyIHVzZXJuYW1lLic7XG5cbiAgLy8gY2hlY2sgd2hldGhlciB0aGUgcGFzc3dvcmQgbWVldHMgdGhlIHBhc3N3b3JkIHN0cmVuZ3RoIHJlcXVpcmVtZW50c1xuICBpZiAoXG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnBhdHRlcm5WYWxpZGF0b3IgJiZcbiAgICAgICF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yKHRoaXMuZGF0YS5wYXNzd29yZCkpIHx8XG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRvckNhbGxiYWNrICYmXG4gICAgICAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sodGhpcy5kYXRhLnBhc3N3b3JkKSlcbiAgKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIHBvbGljeUVycm9yKVxuICAgICk7XG4gIH1cblxuICAvLyBjaGVjayB3aGV0aGVyIHBhc3N3b3JkIGNvbnRhaW4gdXNlcm5hbWVcbiAgaWYgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LmRvTm90QWxsb3dVc2VybmFtZSA9PT0gdHJ1ZSkge1xuICAgIGlmICh0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICAgIC8vIHVzZXJuYW1lIGlzIG5vdCBwYXNzZWQgZHVyaW5nIHBhc3N3b3JkIHJlc2V0XG4gICAgICBpZiAodGhpcy5kYXRhLnBhc3N3b3JkLmluZGV4T2YodGhpcy5kYXRhLnVzZXJuYW1lKSA+PSAwKVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIGNvbnRhaW5zVXNlcm5hbWVFcnJvcilcbiAgICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gcmV0cmlldmUgdGhlIFVzZXIgb2JqZWN0IHVzaW5nIG9iamVjdElkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgIC5maW5kKCdfVXNlcicsIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9KVxuICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggIT0gMSkge1xuICAgICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodGhpcy5kYXRhLnBhc3N3b3JkLmluZGV4T2YocmVzdWx0c1swXS51c2VybmFtZSkgPj0gMClcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgICAgY29udGFpbnNVc2VybmFtZUVycm9yXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkgPSBmdW5jdGlvbigpIHtcbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBpcyByZXBlYXRpbmcgZnJvbSBzcGVjaWZpZWQgaGlzdG9yeVxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkpIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5maW5kKFxuICAgICAgICAnX1VzZXInLFxuICAgICAgICB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgeyBrZXlzOiBbJ19wYXNzd29yZF9oaXN0b3J5JywgJ19oYXNoZWRfcGFzc3dvcmQnXSB9XG4gICAgICApXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgIGxldCBvbGRQYXNzd29yZHMgPSBbXTtcbiAgICAgICAgaWYgKHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnkpXG4gICAgICAgICAgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgICAgdXNlci5fcGFzc3dvcmRfaGlzdG9yeSxcbiAgICAgICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDFcbiAgICAgICAgICApO1xuICAgICAgICBvbGRQYXNzd29yZHMucHVzaCh1c2VyLnBhc3N3b3JkKTtcbiAgICAgICAgY29uc3QgbmV3UGFzc3dvcmQgPSB0aGlzLmRhdGEucGFzc3dvcmQ7XG4gICAgICAgIC8vIGNvbXBhcmUgdGhlIG5ldyBwYXNzd29yZCBoYXNoIHdpdGggYWxsIG9sZCBwYXNzd29yZCBoYXNoZXNcbiAgICAgICAgY29uc3QgcHJvbWlzZXMgPSBvbGRQYXNzd29yZHMubWFwKGZ1bmN0aW9uKGhhc2gpIHtcbiAgICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uY29tcGFyZShuZXdQYXNzd29yZCwgaGFzaCkudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdClcbiAgICAgICAgICAgICAgLy8gcmVqZWN0IGlmIHRoZXJlIGlzIGEgbWF0Y2hcbiAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KCdSRVBFQVRfUEFTU1dPUkQnKTtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIHdhaXQgZm9yIGFsbCBjb21wYXJpc29ucyB0byBjb21wbGV0ZVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwocHJvbWlzZXMpXG4gICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyID09PSAnUkVQRUFUX1BBU1NXT1JEJylcbiAgICAgICAgICAgICAgLy8gYSBtYXRjaCB3YXMgZm91bmRcbiAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgICAgICBgTmV3IHBhc3N3b3JkIHNob3VsZCBub3QgYmUgdGhlIHNhbWUgYXMgbGFzdCAke3RoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeX0gcGFzc3dvcmRzLmBcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEb24ndCBnZW5lcmF0ZSBzZXNzaW9uIGZvciB1cGRhdGluZyB1c2VyICh0aGlzLnF1ZXJ5IGlzIHNldCkgdW5sZXNzIGF1dGhEYXRhIGV4aXN0c1xuICBpZiAodGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERvbid0IGdlbmVyYXRlIG5ldyBzZXNzaW9uVG9rZW4gaWYgbGlua2luZyB2aWEgc2Vzc2lvblRva2VuXG4gIGlmICh0aGlzLmF1dGgudXNlciAmJiB0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgICF0aGlzLnN0b3JhZ2VbJ2F1dGhQcm92aWRlciddICYmIC8vIHNpZ251cCBjYWxsLCB3aXRoXG4gICAgdGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCAmJiAvLyBubyBsb2dpbiB3aXRob3V0IHZlcmlmaWNhdGlvblxuICAgIHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHNcbiAgKSB7XG4gICAgLy8gdmVyaWZpY2F0aW9uIGlzIG9uXG4gICAgcmV0dXJuOyAvLyBkbyBub3QgY3JlYXRlIHRoZSBzZXNzaW9uIHRva2VuIGluIHRoYXQgY2FzZSFcbiAgfVxuICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW4oKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY3JlYXRlU2Vzc2lvblRva2VuID0gYXN5bmMgZnVuY3Rpb24oKSB7XG4gIC8vIGNsb3VkIGluc3RhbGxhdGlvbklkIGZyb20gQ2xvdWQgQ29kZSxcbiAgLy8gbmV2ZXIgY3JlYXRlIHNlc3Npb24gdG9rZW5zIGZyb20gdGhlcmUuXG4gIGlmICh0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQgJiYgdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkID09PSAnY2xvdWQnKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgeyBzZXNzaW9uRGF0YSwgY3JlYXRlU2Vzc2lvbiB9ID0gQXV0aC5jcmVhdGVTZXNzaW9uKHRoaXMuY29uZmlnLCB7XG4gICAgdXNlcklkOiB0aGlzLm9iamVjdElkKCksXG4gICAgY3JlYXRlZFdpdGg6IHtcbiAgICAgIGFjdGlvbjogdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSA/ICdsb2dpbicgOiAnc2lnbnVwJyxcbiAgICAgIGF1dGhQcm92aWRlcjogdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSB8fCAncGFzc3dvcmQnLFxuICAgIH0sXG4gICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgfSk7XG5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2Uuc2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcbn07XG5cbi8vIERlbGV0ZSBlbWFpbCByZXNldCB0b2tlbnMgaWYgdXNlciBpcyBjaGFuZ2luZyBwYXNzd29yZCBvciBlbWFpbC5cblJlc3RXcml0ZS5wcm90b3R5cGUuZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IHRoaXMucXVlcnkgPT09IG51bGwpIHtcbiAgICAvLyBudWxsIHF1ZXJ5IG1lYW5zIGNyZWF0ZVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgncGFzc3dvcmQnIGluIHRoaXMuZGF0YSB8fCAnZW1haWwnIGluIHRoaXMuZGF0YSkge1xuICAgIGNvbnN0IGFkZE9wcyA9IHtcbiAgICAgIF9wZXJpc2hhYmxlX3Rva2VuOiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgICBfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0OiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgfTtcbiAgICB0aGlzLmRhdGEgPSBPYmplY3QuYXNzaWduKHRoaXMuZGF0YSwgYWRkT3BzKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zID0gZnVuY3Rpb24oKSB7XG4gIC8vIE9ubHkgZm9yIF9TZXNzaW9uLCBhbmQgYXQgY3JlYXRpb24gdGltZVxuICBpZiAodGhpcy5jbGFzc05hbWUgIT0gJ19TZXNzaW9uJyB8fCB0aGlzLnF1ZXJ5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERlc3Ryb3kgdGhlIHNlc3Npb25zIGluICdCYWNrZ3JvdW5kJ1xuICBjb25zdCB7IHVzZXIsIGluc3RhbGxhdGlvbklkLCBzZXNzaW9uVG9rZW4gfSA9IHRoaXMuZGF0YTtcbiAgaWYgKCF1c2VyIHx8ICFpbnN0YWxsYXRpb25JZCkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXVzZXIub2JqZWN0SWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveShcbiAgICAnX1Nlc3Npb24nLFxuICAgIHtcbiAgICAgIHVzZXIsXG4gICAgICBpbnN0YWxsYXRpb25JZCxcbiAgICAgIHNlc3Npb25Ub2tlbjogeyAkbmU6IHNlc3Npb25Ub2tlbiB9LFxuICAgIH0sXG4gICAge30sXG4gICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgKTtcbn07XG5cbi8vIEhhbmRsZXMgYW55IGZvbGxvd3VwIGxvZ2ljXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUZvbGxvd3VwID0gZnVuY3Rpb24oKSB7XG4gIGlmIChcbiAgICB0aGlzLnN0b3JhZ2UgJiZcbiAgICB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSAmJlxuICAgIHRoaXMuY29uZmlnLnJldm9rZVNlc3Npb25PblBhc3N3b3JkUmVzZXRcbiAgKSB7XG4gICAgdmFyIHNlc3Npb25RdWVyeSA9IHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBkZWxldGUgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ107XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuZGVzdHJveSgnX1Nlc3Npb24nLCBzZXNzaW9uUXVlcnkpXG4gICAgICAudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnZ2VuZXJhdGVOZXdTZXNzaW9uJ107XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuKCkudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnc2VuZFZlcmlmaWNhdGlvbkVtYWlsJ107XG4gICAgLy8gRmlyZSBhbmQgZm9yZ2V0IVxuICAgIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNlbmRWZXJpZmljYXRpb25FbWFpbCh0aGlzLmRhdGEpO1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcyk7XG4gIH1cbn07XG5cbi8vIEhhbmRsZXMgdGhlIF9TZXNzaW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gX1Nlc3Npb24gb2JqZWN0LlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVTZXNzaW9uID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMuY2xhc3NOYW1lICE9PSAnX1Nlc3Npb24nKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGgudXNlciAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLFxuICAgICAgJ1Nlc3Npb24gdG9rZW4gcmVxdWlyZWQuJ1xuICAgICk7XG4gIH1cblxuICAvLyBUT0RPOiBWZXJpZnkgcHJvcGVyIGVycm9yIHRvIHRocm93XG4gIGlmICh0aGlzLmRhdGEuQUNMKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSxcbiAgICAgICdDYW5ub3Qgc2V0ICcgKyAnQUNMIG9uIGEgU2Vzc2lvbi4nXG4gICAgKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgaWYgKFxuICAgICAgdGhpcy5kYXRhLnVzZXIgJiZcbiAgICAgICF0aGlzLmF1dGguaXNNYXN0ZXIgJiZcbiAgICAgIHRoaXMuZGF0YS51c2VyLm9iamVjdElkICE9IHRoaXMuYXV0aC51c2VyLmlkXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuZGF0YS5zZXNzaW9uVG9rZW4pIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FKTtcbiAgICB9XG4gIH1cblxuICBpZiAoIXRoaXMucXVlcnkgJiYgIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIGNvbnN0IGFkZGl0aW9uYWxTZXNzaW9uRGF0YSA9IHt9O1xuICAgIGZvciAodmFyIGtleSBpbiB0aGlzLmRhdGEpIHtcbiAgICAgIGlmIChrZXkgPT09ICdvYmplY3RJZCcgfHwga2V5ID09PSAndXNlcicpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBhZGRpdGlvbmFsU2Vzc2lvbkRhdGFba2V5XSA9IHRoaXMuZGF0YVtrZXldO1xuICAgIH1cblxuICAgIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IEF1dGguY3JlYXRlU2Vzc2lvbih0aGlzLmNvbmZpZywge1xuICAgICAgdXNlcklkOiB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgIGNyZWF0ZWRXaXRoOiB7XG4gICAgICAgIGFjdGlvbjogJ2NyZWF0ZScsXG4gICAgICB9LFxuICAgICAgYWRkaXRpb25hbFNlc3Npb25EYXRhLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKCFyZXN1bHRzLnJlc3BvbnNlKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsXG4gICAgICAgICAgJ0Vycm9yIGNyZWF0aW5nIHNlc3Npb24uJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgc2Vzc2lvbkRhdGFbJ29iamVjdElkJ10gPSByZXN1bHRzLnJlc3BvbnNlWydvYmplY3RJZCddO1xuICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgc3RhdHVzOiAyMDEsXG4gICAgICAgIGxvY2F0aW9uOiByZXN1bHRzLmxvY2F0aW9uLFxuICAgICAgICByZXNwb25zZTogc2Vzc2lvbkRhdGEsXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfSW5zdGFsbGF0aW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gaW5zdGFsbGF0aW9uIG9iamVjdC5cbi8vIElmIGFuIGluc3RhbGxhdGlvbiBpcyBmb3VuZCwgdGhpcyBjYW4gbXV0YXRlIHRoaXMucXVlcnkgYW5kIHR1cm4gYSBjcmVhdGVcbi8vIGludG8gYW4gdXBkYXRlLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVJbnN0YWxsYXRpb24gPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5jbGFzc05hbWUgIT09ICdfSW5zdGFsbGF0aW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChcbiAgICAhdGhpcy5xdWVyeSAmJlxuICAgICF0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiZcbiAgICAhdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgIXRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZFxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAxMzUsXG4gICAgICAnYXQgbGVhc3Qgb25lIElEIGZpZWxkIChkZXZpY2VUb2tlbiwgaW5zdGFsbGF0aW9uSWQpICcgK1xuICAgICAgICAnbXVzdCBiZSBzcGVjaWZpZWQgaW4gdGhpcyBvcGVyYXRpb24nXG4gICAgKTtcbiAgfVxuXG4gIC8vIElmIHRoZSBkZXZpY2UgdG9rZW4gaXMgNjQgY2hhcmFjdGVycyBsb25nLCB3ZSBhc3N1bWUgaXQgaXMgZm9yIGlPU1xuICAvLyBhbmQgbG93ZXJjYXNlIGl0LlxuICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuICYmIHRoaXMuZGF0YS5kZXZpY2VUb2tlbi5sZW5ndGggPT0gNjQpIHtcbiAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4udG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIC8vIFdlIGxvd2VyY2FzZSB0aGUgaW5zdGFsbGF0aW9uSWQgaWYgcHJlc2VudFxuICBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkID0gdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICBsZXQgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQ7XG5cbiAgLy8gSWYgZGF0YS5pbnN0YWxsYXRpb25JZCBpcyBub3Qgc2V0IGFuZCB3ZSdyZSBub3QgbWFzdGVyLCB3ZSBjYW4gbG9va3VwIGluIGF1dGhcbiAgaWYgKCFpbnN0YWxsYXRpb25JZCAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBpbnN0YWxsYXRpb25JZCA9IGluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBVcGRhdGluZyBfSW5zdGFsbGF0aW9uIGJ1dCBub3QgdXBkYXRpbmcgYW55dGhpbmcgY3JpdGljYWxcbiAgaWYgKFxuICAgIHRoaXMucXVlcnkgJiZcbiAgICAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgIWluc3RhbGxhdGlvbklkICYmXG4gICAgIXRoaXMuZGF0YS5kZXZpY2VUeXBlXG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbiAgdmFyIGlkTWF0Y2g7IC8vIFdpbGwgYmUgYSBtYXRjaCBvbiBlaXRoZXIgb2JqZWN0SWQgb3IgaW5zdGFsbGF0aW9uSWRcbiAgdmFyIG9iamVjdElkTWF0Y2g7XG4gIHZhciBpbnN0YWxsYXRpb25JZE1hdGNoO1xuICB2YXIgZGV2aWNlVG9rZW5NYXRjaGVzID0gW107XG5cbiAgLy8gSW5zdGVhZCBvZiBpc3N1aW5nIDMgcmVhZHMsIGxldCdzIGRvIGl0IHdpdGggb25lIE9SLlxuICBjb25zdCBvclF1ZXJpZXMgPSBbXTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIG9yUXVlcmllcy5wdXNoKHtcbiAgICAgIG9iamVjdElkOiB0aGlzLnF1ZXJ5Lm9iamVjdElkLFxuICAgIH0pO1xuICB9XG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIG9yUXVlcmllcy5wdXNoKHtcbiAgICAgIGluc3RhbGxhdGlvbklkOiBpbnN0YWxsYXRpb25JZCxcbiAgICB9KTtcbiAgfVxuICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goeyBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuIH0pO1xuICB9XG5cbiAgaWYgKG9yUXVlcmllcy5sZW5ndGggPT0gMCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHByb21pc2UgPSBwcm9taXNlXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAgICdfSW5zdGFsbGF0aW9uJyxcbiAgICAgICAge1xuICAgICAgICAgICRvcjogb3JRdWVyaWVzLFxuICAgICAgICB9LFxuICAgICAgICB7fVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgcmVzdWx0cy5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLnF1ZXJ5ICYmXG4gICAgICAgICAgdGhpcy5xdWVyeS5vYmplY3RJZCAmJlxuICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9PSB0aGlzLnF1ZXJ5Lm9iamVjdElkXG4gICAgICAgICkge1xuICAgICAgICAgIG9iamVjdElkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5pbnN0YWxsYXRpb25JZCA9PSBpbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIGluc3RhbGxhdGlvbklkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5kZXZpY2VUb2tlbiA9PSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgLy8gU2FuaXR5IGNoZWNrcyB3aGVuIHJ1bm5pbmcgYSBxdWVyeVxuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICBpZiAoIW9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgICAgJ09iamVjdCBub3QgZm91bmQgZm9yIHVwZGF0ZS4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAhPT0gb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAxMzYsXG4gICAgICAgICAgICAnaW5zdGFsbGF0aW9uSWQgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAhPT0gb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICAhb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAxMzYsXG4gICAgICAgICAgICAnZGV2aWNlVG9rZW4gbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICE9PSBvYmplY3RJZE1hdGNoLmRldmljZVR5cGVcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgMTM2LFxuICAgICAgICAgICAgJ2RldmljZVR5cGUgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIG9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgaWRNYXRjaCA9IG9iamVjdElkTWF0Y2g7XG4gICAgICB9XG5cbiAgICAgIGlmIChpbnN0YWxsYXRpb25JZCAmJiBpbnN0YWxsYXRpb25JZE1hdGNoKSB7XG4gICAgICAgIGlkTWF0Y2ggPSBpbnN0YWxsYXRpb25JZE1hdGNoO1xuICAgICAgfVxuICAgICAgLy8gbmVlZCB0byBzcGVjaWZ5IGRldmljZVR5cGUgb25seSBpZiBpdCdzIG5ld1xuICAgICAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJiAhaWRNYXRjaCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgMTM1LFxuICAgICAgICAgICdkZXZpY2VUeXBlIG11c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgaWYgKCFpZE1hdGNoKSB7XG4gICAgICAgIGlmICghZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoID09IDEgJiZcbiAgICAgICAgICAoIWRldmljZVRva2VuTWF0Y2hlc1swXVsnaW5zdGFsbGF0aW9uSWQnXSB8fCAhaW5zdGFsbGF0aW9uSWQpXG4gICAgICAgICkge1xuICAgICAgICAgIC8vIFNpbmdsZSBtYXRjaCBvbiBkZXZpY2UgdG9rZW4gYnV0IG5vbmUgb24gaW5zdGFsbGF0aW9uSWQsIGFuZCBlaXRoZXJcbiAgICAgICAgICAvLyB0aGUgcGFzc2VkIG9iamVjdCBvciB0aGUgbWF0Y2ggaXMgbWlzc2luZyBhbiBpbnN0YWxsYXRpb25JZCwgc28gd2VcbiAgICAgICAgICAvLyBjYW4ganVzdCByZXR1cm4gdGhlIG1hdGNoLlxuICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgIH0gZWxzZSBpZiAoIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIDEzMixcbiAgICAgICAgICAgICdNdXN0IHNwZWNpZnkgaW5zdGFsbGF0aW9uSWQgd2hlbiBkZXZpY2VUb2tlbiAnICtcbiAgICAgICAgICAgICAgJ21hdGNoZXMgbXVsdGlwbGUgSW5zdGFsbGF0aW9uIG9iamVjdHMnXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBNdWx0aXBsZSBkZXZpY2UgdG9rZW4gbWF0Y2hlcyBhbmQgd2Ugc3BlY2lmaWVkIGFuIGluc3RhbGxhdGlvbiBJRCxcbiAgICAgICAgICAvLyBvciBhIHNpbmdsZSBtYXRjaCB3aGVyZSBib3RoIHRoZSBwYXNzZWQgYW5kIG1hdGNoaW5nIG9iamVjdHMgaGF2ZVxuICAgICAgICAgIC8vIGFuIGluc3RhbGxhdGlvbiBJRC4gVHJ5IGNsZWFuaW5nIG91dCBvbGQgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoXG4gICAgICAgICAgLy8gdGhlIGRldmljZVRva2VuLCBhbmQgcmV0dXJuIG5pbCB0byBzaWduYWwgdGhhdCBhIG5ldyBvYmplY3Qgc2hvdWxkXG4gICAgICAgICAgLy8gYmUgY3JlYXRlZC5cbiAgICAgICAgICB2YXIgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHtcbiAgICAgICAgICAgICAgJG5lOiBpbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfTtcbiAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KS5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgaWYgKGVyci5jb2RlID09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgLy8gbm8gZGVsZXRpb25zIHdlcmUgbWFkZS4gQ2FuIGJlIGlnbm9yZWQuXG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIHJldGhyb3cgdGhlIGVycm9yXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmXG4gICAgICAgICAgIWRldmljZVRva2VuTWF0Y2hlc1swXVsnaW5zdGFsbGF0aW9uSWQnXVxuICAgICAgICApIHtcbiAgICAgICAgICAvLyBFeGFjdGx5IG9uZSBkZXZpY2UgdG9rZW4gbWF0Y2ggYW5kIGl0IGRvZXNuJ3QgaGF2ZSBhbiBpbnN0YWxsYXRpb25cbiAgICAgICAgICAvLyBJRC4gVGhpcyBpcyB0aGUgb25lIGNhc2Ugd2hlcmUgd2Ugd2FudCB0byBtZXJnZSB3aXRoIHRoZSBleGlzdGluZ1xuICAgICAgICAgIC8vIG9iamVjdC5cbiAgICAgICAgICBjb25zdCBkZWxRdWVyeSA9IHsgb2JqZWN0SWQ6IGlkTWF0Y2gub2JqZWN0SWQgfTtcbiAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAgIC5kZXN0cm95KCdfSW5zdGFsbGF0aW9uJywgZGVsUXVlcnkpXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgICAgLy8gbm8gZGVsZXRpb25zIHdlcmUgbWFkZS4gQ2FuIGJlIGlnbm9yZWRcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgLy8gcmV0aHJvdyB0aGUgZXJyb3JcbiAgICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgICAgICAgICBpZE1hdGNoLmRldmljZVRva2VuICE9IHRoaXMuZGF0YS5kZXZpY2VUb2tlblxuICAgICAgICAgICkge1xuICAgICAgICAgICAgLy8gV2UncmUgc2V0dGluZyB0aGUgZGV2aWNlIHRva2VuIG9uIGFuIGV4aXN0aW5nIGluc3RhbGxhdGlvbiwgc29cbiAgICAgICAgICAgIC8vIHdlIHNob3VsZCB0cnkgY2xlYW5pbmcgb3V0IG9sZCBpbnN0YWxsYXRpb25zIHRoYXQgbWF0Y2ggdGhpc1xuICAgICAgICAgICAgLy8gZGV2aWNlIHRva2VuLlxuICAgICAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICAgIGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgLy8gV2UgaGF2ZSBhIHVuaXF1ZSBpbnN0YWxsIElkLCB1c2UgdGhhdCB0byBwcmVzZXJ2ZVxuICAgICAgICAgICAgLy8gdGhlIGludGVyZXN0aW5nIGluc3RhbGxhdGlvblxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgICAgICBkZWxRdWVyeVsnaW5zdGFsbGF0aW9uSWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgJiZcbiAgICAgICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgPT0gdGhpcy5kYXRhLm9iamVjdElkXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gd2UgcGFzc2VkIGFuIG9iamVjdElkLCBwcmVzZXJ2ZSB0aGF0IGluc3RhbGF0aW9uXG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydvYmplY3RJZCddID0ge1xuICAgICAgICAgICAgICAgICRuZTogaWRNYXRjaC5vYmplY3RJZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIFdoYXQgdG8gZG8gaGVyZT8gY2FuJ3QgcmVhbGx5IGNsZWFuIHVwIGV2ZXJ5dGhpbmcuLi5cbiAgICAgICAgICAgICAgcmV0dXJuIGlkTWF0Y2gub2JqZWN0SWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ2FwcElkZW50aWZpZXInXSA9IHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAgICAgLmRlc3Ryb3koJ19JbnN0YWxsYXRpb24nLCBkZWxRdWVyeSlcbiAgICAgICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGVyci5jb2RlID09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkLlxuICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAvLyByZXRocm93IHRoZSBlcnJvclxuICAgICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEluIG5vbi1tZXJnZSBzY2VuYXJpb3MsIGp1c3QgcmV0dXJuIHRoZSBpbnN0YWxsYXRpb24gbWF0Y2ggaWRcbiAgICAgICAgICByZXR1cm4gaWRNYXRjaC5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4ob2JqSWQgPT4ge1xuICAgICAgaWYgKG9iaklkKSB7XG4gICAgICAgIHRoaXMucXVlcnkgPSB7IG9iamVjdElkOiBvYmpJZCB9O1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcbiAgICAgIH1cbiAgICAgIC8vIFRPRE86IFZhbGlkYXRlIG9wcyAoYWRkL3JlbW92ZSBvbiBjaGFubmVscywgJGluYyBvbiBiYWRnZSwgZXRjLilcbiAgICB9KTtcbiAgcmV0dXJuIHByb21pc2U7XG59O1xuXG4vLyBJZiB3ZSBzaG9ydC1jaXJjdXRlZCB0aGUgb2JqZWN0IHJlc3BvbnNlIC0gdGhlbiB3ZSBuZWVkIHRvIG1ha2Ugc3VyZSB3ZSBleHBhbmQgYWxsIHRoZSBmaWxlcyxcbi8vIHNpbmNlIHRoaXMgbWlnaHQgbm90IGhhdmUgYSBxdWVyeSwgbWVhbmluZyBpdCB3b24ndCByZXR1cm4gdGhlIGZ1bGwgcmVzdWx0IGJhY2suXG4vLyBUT0RPOiAobmx1dHNlbmtvKSBUaGlzIHNob3VsZCBkaWUgd2hlbiB3ZSBtb3ZlIHRvIHBlci1jbGFzcyBiYXNlZCBjb250cm9sbGVycyBvbiBfU2Vzc2lvbi9fVXNlclxuUmVzdFdyaXRlLnByb3RvdHlwZS5leHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyA9IGZ1bmN0aW9uKCkge1xuICAvLyBDaGVjayB3aGV0aGVyIHdlIGhhdmUgYSBzaG9ydC1jaXJjdWl0ZWQgcmVzcG9uc2UgLSBvbmx5IHRoZW4gcnVuIGV4cGFuc2lvbi5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlXG4gICAgKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5EYXRhYmFzZU9wZXJhdGlvbiA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Sb2xlJykge1xuICAgIHRoaXMuY29uZmlnLmNhY2hlQ29udHJvbGxlci5yb2xlLmNsZWFyKCk7XG4gIH1cblxuICBpZiAoXG4gICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICB0aGlzLnF1ZXJ5ICYmXG4gICAgdGhpcy5hdXRoLmlzVW5hdXRoZW50aWNhdGVkKClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuU0VTU0lPTl9NSVNTSU5HLFxuICAgICAgYENhbm5vdCBtb2RpZnkgdXNlciAke3RoaXMucXVlcnkub2JqZWN0SWR9LmBcbiAgICApO1xuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1Byb2R1Y3QnICYmIHRoaXMuZGF0YS5kb3dubG9hZCkge1xuICAgIHRoaXMuZGF0YS5kb3dubG9hZE5hbWUgPSB0aGlzLmRhdGEuZG93bmxvYWQubmFtZTtcbiAgfVxuXG4gIC8vIFRPRE86IEFkZCBiZXR0ZXIgZGV0ZWN0aW9uIGZvciBBQ0wsIGVuc3VyaW5nIGEgdXNlciBjYW4ndCBiZSBsb2NrZWQgZnJvbVxuICAvLyAgICAgICB0aGVpciBvd24gdXNlciByZWNvcmQuXG4gIGlmICh0aGlzLmRhdGEuQUNMICYmIHRoaXMuZGF0YS5BQ0xbJyp1bnJlc29sdmVkJ10pIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9BQ0wsICdJbnZhbGlkIEFDTC4nKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgLy8gRm9yY2UgdGhlIHVzZXIgdG8gbm90IGxvY2tvdXRcbiAgICAvLyBNYXRjaGVkIHdpdGggcGFyc2UuY29tXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5BQ0wgJiZcbiAgICAgIHRoaXMuYXV0aC5pc01hc3RlciAhPT0gdHJ1ZVxuICAgICkge1xuICAgICAgdGhpcy5kYXRhLkFDTFt0aGlzLnF1ZXJ5Lm9iamVjdElkXSA9IHsgcmVhZDogdHJ1ZSwgd3JpdGU6IHRydWUgfTtcbiAgICB9XG4gICAgLy8gdXBkYXRlIHBhc3N3b3JkIHRpbWVzdGFtcCBpZiB1c2VyIHBhc3N3b3JkIGlzIGJlaW5nIGNoYW5nZWRcbiAgICBpZiAoXG4gICAgICB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICAgdGhpcy5kYXRhLl9oYXNoZWRfcGFzc3dvcmQgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZVxuICAgICkge1xuICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICB9XG4gICAgLy8gSWdub3JlIGNyZWF0ZWRBdCB3aGVuIHVwZGF0ZVxuICAgIGRlbGV0ZSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgbGV0IGRlZmVyID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgLy8gaWYgcGFzc3dvcmQgaGlzdG9yeSBpcyBlbmFibGVkIHRoZW4gc2F2ZSB0aGUgY3VycmVudCBwYXNzd29yZCB0byBoaXN0b3J5XG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5XG4gICAgKSB7XG4gICAgICBkZWZlciA9IHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgIC5maW5kKFxuICAgICAgICAgICdfVXNlcicsXG4gICAgICAgICAgeyBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgICAgeyBrZXlzOiBbJ19wYXNzd29yZF9oaXN0b3J5JywgJ19oYXNoZWRfcGFzc3dvcmQnXSB9XG4gICAgICAgIClcbiAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICAgIHRocm93IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgICAgbGV0IG9sZFBhc3N3b3JkcyA9IFtdO1xuICAgICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KSB7XG4gICAgICAgICAgICBvbGRQYXNzd29yZHMgPSBfLnRha2UoXG4gICAgICAgICAgICAgIHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksXG4gICAgICAgICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy9uLTEgcGFzc3dvcmRzIGdvIGludG8gaGlzdG9yeSBpbmNsdWRpbmcgbGFzdCBwYXNzd29yZFxuICAgICAgICAgIHdoaWxlIChcbiAgICAgICAgICAgIG9sZFBhc3N3b3Jkcy5sZW5ndGggPlxuICAgICAgICAgICAgTWF0aC5tYXgoMCwgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5IC0gMilcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIG9sZFBhc3N3b3Jkcy5zaGlmdCgpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvbGRQYXNzd29yZHMucHVzaCh1c2VyLnBhc3N3b3JkKTtcbiAgICAgICAgICB0aGlzLmRhdGEuX3Bhc3N3b3JkX2hpc3RvcnkgPSBvbGRQYXNzd29yZHM7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBkZWZlci50aGVuKCgpID0+IHtcbiAgICAgIC8vIFJ1biBhbiB1cGRhdGVcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAudXBkYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgICAgICApXG4gICAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICByZXNwb25zZS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICAgICAgICB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKHJlc3BvbnNlLCB0aGlzLmRhdGEpO1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UgPSB7IHJlc3BvbnNlIH07XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIC8vIFNldCB0aGUgZGVmYXVsdCBBQ0wgYW5kIHBhc3N3b3JkIHRpbWVzdGFtcCBmb3IgdGhlIG5ldyBfVXNlclxuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgICAgdmFyIEFDTCA9IHRoaXMuZGF0YS5BQ0w7XG4gICAgICAvLyBkZWZhdWx0IHB1YmxpYyByL3cgQUNMXG4gICAgICBpZiAoIUFDTCkge1xuICAgICAgICBBQ0wgPSB7fTtcbiAgICAgICAgQUNMWycqJ10gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiBmYWxzZSB9O1xuICAgICAgfVxuICAgICAgLy8gbWFrZSBzdXJlIHRoZSB1c2VyIGlzIG5vdCBsb2NrZWQgZG93blxuICAgICAgQUNMW3RoaXMuZGF0YS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgICB0aGlzLmRhdGEuQUNMID0gQUNMO1xuICAgICAgLy8gcGFzc3dvcmQgdGltZXN0YW1wIHRvIGJlIHVzZWQgd2hlbiBwYXNzd29yZCBleHBpcnkgcG9saWN5IGlzIGVuZm9yY2VkXG4gICAgICBpZiAoXG4gICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmXG4gICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlXG4gICAgICApIHtcbiAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSdW4gYSBjcmVhdGVcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5jcmVhdGUoXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLmRhdGEsXG4gICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgZmFsc2UsXG4gICAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicgfHxcbiAgICAgICAgICBlcnJvci5jb2RlICE9PSBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUVcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBRdWljayBjaGVjaywgaWYgd2Ugd2VyZSBhYmxlIHRvIGluZmVyIHRoZSBkdXBsaWNhdGVkIGZpZWxkIG5hbWVcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGVycm9yICYmXG4gICAgICAgICAgZXJyb3IudXNlckluZm8gJiZcbiAgICAgICAgICBlcnJvci51c2VySW5mby5kdXBsaWNhdGVkX2ZpZWxkID09PSAndXNlcm5hbWUnXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOLFxuICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXG4gICAgICAgICAgZXJyb3IgJiZcbiAgICAgICAgICBlcnJvci51c2VySW5mbyAmJlxuICAgICAgICAgIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICdlbWFpbCdcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgdGhpcyB3YXMgYSBmYWlsZWQgdXNlciBjcmVhdGlvbiBkdWUgdG8gdXNlcm5hbWUgb3IgZW1haWwgYWxyZWFkeSB0YWtlbiwgd2UgbmVlZCB0b1xuICAgICAgICAvLyBjaGVjayB3aGV0aGVyIGl0IHdhcyB1c2VybmFtZSBvciBlbWFpbCBhbmQgcmV0dXJuIHRoZSBhcHByb3ByaWF0ZSBlcnJvci5cbiAgICAgICAgLy8gRmFsbGJhY2sgdG8gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgICAgICAvLyBUT0RPOiBTZWUgaWYgd2UgY2FuIGxhdGVyIGRvIHRoaXMgd2l0aG91dCBhZGRpdGlvbmFsIHF1ZXJpZXMgYnkgdXNpbmcgbmFtZWQgaW5kZXhlcy5cbiAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgICAgLmZpbmQoXG4gICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSxcbiAgICAgICAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7IGxpbWl0OiAxIH1cbiAgICAgICAgICApXG4gICAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICAgIHsgZW1haWw6IHRoaXMuZGF0YS5lbWFpbCwgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSB9LFxuICAgICAgICAgICAgICB7IGxpbWl0OiAxIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgIHJlc3BvbnNlLm9iamVjdElkID0gdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICByZXNwb25zZS5jcmVhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgICAgIGlmICh0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lKSB7XG4gICAgICAgICAgcmVzcG9uc2UudXNlcm5hbWUgPSB0aGlzLmRhdGEudXNlcm5hbWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShyZXNwb25zZSwgdGhpcy5kYXRhKTtcbiAgICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgICBzdGF0dXM6IDIwMSxcbiAgICAgICAgICByZXNwb25zZSxcbiAgICAgICAgICBsb2NhdGlvbjogdGhpcy5sb2NhdGlvbigpLFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gIH1cbn07XG5cbi8vIFJldHVybnMgbm90aGluZyAtIGRvZXNuJ3Qgd2FpdCBmb3IgdGhlIHRyaWdnZXIuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkFmdGVyU2F2ZVRyaWdnZXIgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLnJlc3BvbnNlIHx8ICF0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYWZ0ZXJTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBjb25zdCBoYXNBZnRlclNhdmVIb29rID0gdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICApO1xuICBjb25zdCBoYXNMaXZlUXVlcnkgPSB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLmhhc0xpdmVRdWVyeShcbiAgICB0aGlzLmNsYXNzTmFtZVxuICApO1xuICBpZiAoIWhhc0FmdGVyU2F2ZUhvb2sgJiYgIWhhc0xpdmVRdWVyeSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHZhciBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUgfTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIGV4dHJhRGF0YS5vYmplY3RJZCA9IHRoaXMucXVlcnkub2JqZWN0SWQ7XG4gIH1cblxuICAvLyBCdWlsZCB0aGUgb3JpZ2luYWwgb2JqZWN0LCB3ZSBvbmx5IGRvIHRoaXMgZm9yIGEgdXBkYXRlIHdyaXRlLlxuICBsZXQgb3JpZ2luYWxPYmplY3Q7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvcmlnaW5hbE9iamVjdCA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIH1cblxuICAvLyBCdWlsZCB0aGUgaW5mbGF0ZWQgb2JqZWN0LCBkaWZmZXJlbnQgZnJvbSBiZWZvcmVTYXZlLCBvcmlnaW5hbERhdGEgaXMgbm90IGVtcHR5XG4gIC8vIHNpbmNlIGRldmVsb3BlcnMgY2FuIGNoYW5nZSBkYXRhIGluIHRoZSBiZWZvcmVTYXZlLlxuICBjb25zdCB1cGRhdGVkT2JqZWN0ID0gdGhpcy5idWlsZFVwZGF0ZWRPYmplY3QoZXh0cmFEYXRhKTtcbiAgdXBkYXRlZE9iamVjdC5faGFuZGxlU2F2ZVJlc3BvbnNlKFxuICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UsXG4gICAgdGhpcy5yZXNwb25zZS5zdGF0dXMgfHwgMjAwXG4gICk7XG5cbiAgdGhpcy5jb25maWcuZGF0YWJhc2UubG9hZFNjaGVtYSgpLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgLy8gTm90aWZpeSBMaXZlUXVlcnlTZXJ2ZXIgaWYgcG9zc2libGVcbiAgICBjb25zdCBwZXJtcyA9IHNjaGVtYUNvbnRyb2xsZXIuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKFxuICAgICAgdXBkYXRlZE9iamVjdC5jbGFzc05hbWVcbiAgICApO1xuICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIub25BZnRlclNhdmUoXG4gICAgICB1cGRhdGVkT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgIHVwZGF0ZWRPYmplY3QsXG4gICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgIHBlcm1zXG4gICAgKTtcbiAgfSk7XG5cbiAgLy8gUnVuIGFmdGVyU2F2ZSB0cmlnZ2VyXG4gIHJldHVybiB0cmlnZ2Vyc1xuICAgIC5tYXliZVJ1blRyaWdnZXIoXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgb3JpZ2luYWxPYmplY3QsXG4gICAgICB0aGlzLmNvbmZpZyxcbiAgICAgIHRoaXMuY29udGV4dFxuICAgIClcbiAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgaWYgKHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlID0gcmVzdWx0O1xuICAgICAgfVxuICAgIH0pXG4gICAgLmNhdGNoKGZ1bmN0aW9uKGVycikge1xuICAgICAgbG9nZ2VyLndhcm4oJ2FmdGVyU2F2ZSBjYXVnaHQgYW4gZXJyb3InLCBlcnIpO1xuICAgIH0pO1xufTtcblxuLy8gQSBoZWxwZXIgdG8gZmlndXJlIG91dCB3aGF0IGxvY2F0aW9uIHRoaXMgb3BlcmF0aW9uIGhhcHBlbnMgYXQuXG5SZXN0V3JpdGUucHJvdG90eXBlLmxvY2F0aW9uID0gZnVuY3Rpb24oKSB7XG4gIHZhciBtaWRkbGUgPVxuICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInID8gJy91c2Vycy8nIDogJy9jbGFzc2VzLycgKyB0aGlzLmNsYXNzTmFtZSArICcvJztcbiAgcmV0dXJuIHRoaXMuY29uZmlnLm1vdW50ICsgbWlkZGxlICsgdGhpcy5kYXRhLm9iamVjdElkO1xufTtcblxuLy8gQSBoZWxwZXIgdG8gZ2V0IHRoZSBvYmplY3QgaWQgZm9yIHRoaXMgb3BlcmF0aW9uLlxuLy8gQmVjYXVzZSBpdCBjb3VsZCBiZSBlaXRoZXIgb24gdGhlIHF1ZXJ5IG9yIG9uIHRoZSBkYXRhXG5SZXN0V3JpdGUucHJvdG90eXBlLm9iamVjdElkID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLmRhdGEub2JqZWN0SWQgfHwgdGhpcy5xdWVyeS5vYmplY3RJZDtcbn07XG5cbi8vIFJldHVybnMgYSBjb3B5IG9mIHRoZSBkYXRhIGFuZCBkZWxldGUgYmFkIGtleXMgKF9hdXRoX2RhdGEsIF9oYXNoZWRfcGFzc3dvcmQuLi4pXG5SZXN0V3JpdGUucHJvdG90eXBlLnNhbml0aXplZERhdGEgPSBmdW5jdGlvbigpIHtcbiAgY29uc3QgZGF0YSA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YSkucmVkdWNlKChkYXRhLCBrZXkpID0+IHtcbiAgICAvLyBSZWdleHAgY29tZXMgZnJvbSBQYXJzZS5PYmplY3QucHJvdG90eXBlLnZhbGlkYXRlXG4gICAgaWYgKCEvXltBLVphLXpdWzAtOUEtWmEtel9dKiQvLnRlc3Qoa2V5KSkge1xuICAgICAgZGVsZXRlIGRhdGFba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIGRhdGE7XG4gIH0sIGRlZXBjb3B5KHRoaXMuZGF0YSkpO1xuICByZXR1cm4gUGFyc2UuX2RlY29kZSh1bmRlZmluZWQsIGRhdGEpO1xufTtcblxuLy8gUmV0dXJucyBhbiB1cGRhdGVkIGNvcHkgb2YgdGhlIG9iamVjdFxuUmVzdFdyaXRlLnByb3RvdHlwZS5idWlsZFVwZGF0ZWRPYmplY3QgPSBmdW5jdGlvbihleHRyYURhdGEpIHtcbiAgY29uc3QgdXBkYXRlZE9iamVjdCA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIE9iamVjdC5rZXlzKHRoaXMuZGF0YSkucmVkdWNlKGZ1bmN0aW9uKGRhdGEsIGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgLy8gc3ViZG9jdW1lbnQga2V5IHdpdGggZG90IG5vdGF0aW9uICgneC55Jzp2ID0+ICd4Jzp7J3knOnZ9KVxuICAgICAgY29uc3Qgc3BsaXR0ZWRLZXkgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgIGNvbnN0IHBhcmVudFByb3AgPSBzcGxpdHRlZEtleVswXTtcbiAgICAgIGxldCBwYXJlbnRWYWwgPSB1cGRhdGVkT2JqZWN0LmdldChwYXJlbnRQcm9wKTtcbiAgICAgIGlmICh0eXBlb2YgcGFyZW50VmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICBwYXJlbnRWYWwgPSB7fTtcbiAgICAgIH1cbiAgICAgIHBhcmVudFZhbFtzcGxpdHRlZEtleVsxXV0gPSBkYXRhW2tleV07XG4gICAgICB1cGRhdGVkT2JqZWN0LnNldChwYXJlbnRQcm9wLCBwYXJlbnRWYWwpO1xuICAgICAgZGVsZXRlIGRhdGFba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIGRhdGE7XG4gIH0sIGRlZXBjb3B5KHRoaXMuZGF0YSkpO1xuXG4gIHVwZGF0ZWRPYmplY3Quc2V0KHRoaXMuc2FuaXRpemVkRGF0YSgpKTtcbiAgcmV0dXJuIHVwZGF0ZWRPYmplY3Q7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNsZWFuVXNlckF1dGhEYXRhID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICBjb25zdCB1c2VyID0gdGhpcy5yZXNwb25zZS5yZXNwb25zZTtcbiAgICBpZiAodXNlci5hdXRoRGF0YSkge1xuICAgICAgT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgIGlmICh1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBpZiAoT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkubGVuZ3RoID09IDApIHtcbiAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGE7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhID0gZnVuY3Rpb24ocmVzcG9uc2UsIGRhdGEpIHtcbiAgaWYgKF8uaXNFbXB0eSh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlcikpIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgY2xpZW50U3VwcG9ydHNEZWxldGUgPSBDbGllbnRTREsuc3VwcG9ydHNGb3J3YXJkRGVsZXRlKHRoaXMuY2xpZW50U0RLKTtcbiAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGNvbnN0IGRhdGFWYWx1ZSA9IGRhdGFbZmllbGROYW1lXTtcblxuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3BvbnNlLCBmaWVsZE5hbWUpKSB7XG4gICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgIH1cblxuICAgIC8vIFN0cmlwcyBvcGVyYXRpb25zIGZyb20gcmVzcG9uc2VzXG4gICAgaWYgKHJlc3BvbnNlW2ZpZWxkTmFtZV0gJiYgcmVzcG9uc2VbZmllbGROYW1lXS5fX29wKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2VbZmllbGROYW1lXTtcbiAgICAgIGlmIChjbGllbnRTdXBwb3J0c0RlbGV0ZSAmJiBkYXRhVmFsdWUuX19vcCA9PSAnRGVsZXRlJykge1xuICAgICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiByZXNwb25zZTtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IFJlc3RXcml0ZTtcbm1vZHVsZS5leHBvcnRzID0gUmVzdFdyaXRlO1xuIl19
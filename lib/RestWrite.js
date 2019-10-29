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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0V3JpdGUuanMiXSwibmFtZXMiOlsiU2NoZW1hQ29udHJvbGxlciIsInJlcXVpcmUiLCJkZWVwY29weSIsIkF1dGgiLCJjcnlwdG9VdGlscyIsInBhc3N3b3JkQ3J5cHRvIiwiUGFyc2UiLCJ0cmlnZ2VycyIsIkNsaWVudFNESyIsIlJlc3RXcml0ZSIsImNvbmZpZyIsImF1dGgiLCJjbGFzc05hbWUiLCJxdWVyeSIsImRhdGEiLCJvcmlnaW5hbERhdGEiLCJjbGllbnRTREsiLCJpc1JlYWRPbmx5IiwiRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwic3RvcmFnZSIsInJ1bk9wdGlvbnMiLCJjb250ZXh0Iiwib2JqZWN0SWQiLCJJTlZBTElEX0tFWV9OQU1FIiwiaWQiLCJyZXNwb25zZSIsInVwZGF0ZWRBdCIsIl9lbmNvZGUiLCJEYXRlIiwiaXNvIiwidmFsaWRTY2hlbWFDb250cm9sbGVyIiwicHJvdG90eXBlIiwiZXhlY3V0ZSIsIlByb21pc2UiLCJyZXNvbHZlIiwidGhlbiIsImdldFVzZXJBbmRSb2xlQUNMIiwidmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uIiwiaGFuZGxlSW5zdGFsbGF0aW9uIiwiaGFuZGxlU2Vzc2lvbiIsInZhbGlkYXRlQXV0aERhdGEiLCJydW5CZWZvcmVTYXZlVHJpZ2dlciIsImRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkIiwidmFsaWRhdGVTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwic2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCIsInRyYW5zZm9ybVVzZXIiLCJleHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyIsImRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMiLCJydW5EYXRhYmFzZU9wZXJhdGlvbiIsImNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkIiwiaGFuZGxlRm9sbG93dXAiLCJydW5BZnRlclNhdmVUcmlnZ2VyIiwiY2xlYW5Vc2VyQXV0aERhdGEiLCJpc01hc3RlciIsImFjbCIsInVzZXIiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsImNvbmNhdCIsImFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiIsInN5c3RlbUNsYXNzZXMiLCJpbmRleE9mIiwiZGF0YWJhc2UiLCJsb2FkU2NoZW1hIiwiaGFzQ2xhc3MiLCJ2YWxpZGF0ZU9iamVjdCIsInRyaWdnZXJFeGlzdHMiLCJUeXBlcyIsImJlZm9yZVNhdmUiLCJhcHBsaWNhdGlvbklkIiwiZXh0cmFEYXRhIiwib3JpZ2luYWxPYmplY3QiLCJ1cGRhdGVkT2JqZWN0IiwiYnVpbGRVcGRhdGVkT2JqZWN0IiwiaW5mbGF0ZSIsImRhdGFiYXNlUHJvbWlzZSIsInVwZGF0ZSIsImNyZWF0ZSIsInJlc3VsdCIsImxlbmd0aCIsIk9CSkVDVF9OT1RfRk9VTkQiLCJtYXliZVJ1blRyaWdnZXIiLCJvYmplY3QiLCJmaWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIiwiXyIsInJlZHVjZSIsInZhbHVlIiwia2V5IiwiaXNFcXVhbCIsInB1c2giLCJydW5CZWZvcmVMb2dpblRyaWdnZXIiLCJ1c2VyRGF0YSIsImJlZm9yZUxvZ2luIiwiZ2V0QWxsQ2xhc3NlcyIsImFsbENsYXNzZXMiLCJzY2hlbWEiLCJmaW5kIiwib25lQ2xhc3MiLCJzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQiLCJmaWVsZE5hbWUiLCJzZXREZWZhdWx0IiwidW5kZWZpbmVkIiwiX19vcCIsImZpZWxkcyIsImRlZmF1bHRWYWx1ZSIsInJlcXVpcmVkIiwiVkFMSURBVElPTl9FUlJPUiIsImFzc2lnbk9iamVjdElkIiwibmV3T2JqZWN0SWQiLCJvYmplY3RJZFNpemUiLCJvYmplY3RJZFVzZVRpbWUiLCJvYmplY3RJZFByZWZpeGVzIiwiY3JlYXRlZEF0IiwiT2JqZWN0Iiwia2V5cyIsImZvckVhY2giLCJhdXRoRGF0YSIsInVzZXJuYW1lIiwiaXNFbXB0eSIsIlVTRVJOQU1FX01JU1NJTkciLCJwYXNzd29yZCIsIlBBU1NXT1JEX01JU1NJTkciLCJwcm92aWRlcnMiLCJjYW5IYW5kbGVBdXRoRGF0YSIsImNhbkhhbmRsZSIsInByb3ZpZGVyIiwicHJvdmlkZXJBdXRoRGF0YSIsImhhc1Rva2VuIiwiaGFuZGxlQXV0aERhdGEiLCJVTlNVUFBPUlRFRF9TRVJWSUNFIiwiaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uIiwidmFsaWRhdGlvbnMiLCJtYXAiLCJhdXRoRGF0YU1hbmFnZXIiLCJnZXRWYWxpZGF0b3JGb3JQcm92aWRlciIsImFsbCIsImZpbmRVc2Vyc1dpdGhBdXRoRGF0YSIsIm1lbW8iLCJxdWVyeUtleSIsImZpbHRlciIsInEiLCJmaW5kUHJvbWlzZSIsIiRvciIsImZpbHRlcmVkT2JqZWN0c0J5QUNMIiwib2JqZWN0cyIsIkFDTCIsInJlc3VsdHMiLCJyIiwiam9pbiIsInVzZXJSZXN1bHQiLCJtdXRhdGVkQXV0aERhdGEiLCJwcm92aWRlckRhdGEiLCJ1c2VyQXV0aERhdGEiLCJoYXNNdXRhdGVkQXV0aERhdGEiLCJ1c2VySWQiLCJsb2NhdGlvbiIsIkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQiLCJwcm9taXNlIiwiZXJyb3IiLCJSZXN0UXVlcnkiLCJtYXN0ZXIiLCJfX3R5cGUiLCJzZXNzaW9uIiwiY2FjaGVDb250cm9sbGVyIiwiZGVsIiwic2Vzc2lvblRva2VuIiwiX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kiLCJoYXNoIiwiaGFzaGVkUGFzc3dvcmQiLCJfaGFzaGVkX3Bhc3N3b3JkIiwiX3ZhbGlkYXRlVXNlck5hbWUiLCJfdmFsaWRhdGVFbWFpbCIsInJhbmRvbVN0cmluZyIsInJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lIiwiJG5lIiwibGltaXQiLCJVU0VSTkFNRV9UQUtFTiIsImVtYWlsIiwibWF0Y2giLCJyZWplY3QiLCJJTlZBTElEX0VNQUlMX0FERFJFU1MiLCJFTUFJTF9UQUtFTiIsInVzZXJDb250cm9sbGVyIiwic2V0RW1haWxWZXJpZnlUb2tlbiIsInBhc3N3b3JkUG9saWN5IiwiX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMiLCJfdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkiLCJwb2xpY3lFcnJvciIsInZhbGlkYXRpb25FcnJvciIsImNvbnRhaW5zVXNlcm5hbWVFcnJvciIsInBhdHRlcm5WYWxpZGF0b3IiLCJ2YWxpZGF0b3JDYWxsYmFjayIsImRvTm90QWxsb3dVc2VybmFtZSIsIm1heFBhc3N3b3JkSGlzdG9yeSIsIm9sZFBhc3N3b3JkcyIsIl9wYXNzd29yZF9oaXN0b3J5IiwidGFrZSIsIm5ld1Bhc3N3b3JkIiwicHJvbWlzZXMiLCJjb21wYXJlIiwiY2F0Y2giLCJlcnIiLCJwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsIiwidmVyaWZ5VXNlckVtYWlscyIsImNyZWF0ZVNlc3Npb25Ub2tlbiIsImluc3RhbGxhdGlvbklkIiwic2Vzc2lvbkRhdGEiLCJjcmVhdGVTZXNzaW9uIiwiY3JlYXRlZFdpdGgiLCJhY3Rpb24iLCJhdXRoUHJvdmlkZXIiLCJhZGRPcHMiLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJhc3NpZ24iLCJkZXN0cm95IiwicmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCIsInNlc3Npb25RdWVyeSIsImJpbmQiLCJzZW5kVmVyaWZpY2F0aW9uRW1haWwiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCJhZGRpdGlvbmFsU2Vzc2lvbkRhdGEiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJzdGF0dXMiLCJkZXZpY2VUb2tlbiIsInRvTG93ZXJDYXNlIiwiZGV2aWNlVHlwZSIsImlkTWF0Y2giLCJvYmplY3RJZE1hdGNoIiwiaW5zdGFsbGF0aW9uSWRNYXRjaCIsImRldmljZVRva2VuTWF0Y2hlcyIsIm9yUXVlcmllcyIsImRlbFF1ZXJ5IiwiYXBwSWRlbnRpZmllciIsImNvZGUiLCJvYmpJZCIsImZpbGVzQ29udHJvbGxlciIsImV4cGFuZEZpbGVzSW5PYmplY3QiLCJyb2xlIiwiY2xlYXIiLCJpc1VuYXV0aGVudGljYXRlZCIsIlNFU1NJT05fTUlTU0lORyIsImRvd25sb2FkIiwiZG93bmxvYWROYW1lIiwibmFtZSIsIklOVkFMSURfQUNMIiwicmVhZCIsIndyaXRlIiwibWF4UGFzc3dvcmRBZ2UiLCJfcGFzc3dvcmRfY2hhbmdlZF9hdCIsImRlZmVyIiwiTWF0aCIsIm1heCIsInNoaWZ0IiwiX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEiLCJEVVBMSUNBVEVfVkFMVUUiLCJ1c2VySW5mbyIsImR1cGxpY2F0ZWRfZmllbGQiLCJoYXNBZnRlclNhdmVIb29rIiwiYWZ0ZXJTYXZlIiwiaGFzTGl2ZVF1ZXJ5IiwibGl2ZVF1ZXJ5Q29udHJvbGxlciIsIl9oYW5kbGVTYXZlUmVzcG9uc2UiLCJwZXJtcyIsImdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsIm9uQWZ0ZXJTYXZlIiwibG9nZ2VyIiwid2FybiIsIm1pZGRsZSIsIm1vdW50Iiwic2FuaXRpemVkRGF0YSIsInRlc3QiLCJfZGVjb2RlIiwic3BsaXR0ZWRLZXkiLCJzcGxpdCIsInBhcmVudFByb3AiLCJwYXJlbnRWYWwiLCJnZXQiLCJzZXQiLCJjbGllbnRTdXBwb3J0c0RlbGV0ZSIsInN1cHBvcnRzRm9yd2FyZERlbGV0ZSIsImRhdGFWYWx1ZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFhQTs7QUFDQTs7QUFDQTs7OztBQWZBO0FBQ0E7QUFDQTtBQUVBLElBQUlBLGdCQUFnQixHQUFHQyxPQUFPLENBQUMsZ0NBQUQsQ0FBOUI7O0FBQ0EsSUFBSUMsUUFBUSxHQUFHRCxPQUFPLENBQUMsVUFBRCxDQUF0Qjs7QUFFQSxNQUFNRSxJQUFJLEdBQUdGLE9BQU8sQ0FBQyxRQUFELENBQXBCOztBQUNBLElBQUlHLFdBQVcsR0FBR0gsT0FBTyxDQUFDLGVBQUQsQ0FBekI7O0FBQ0EsSUFBSUksY0FBYyxHQUFHSixPQUFPLENBQUMsWUFBRCxDQUE1Qjs7QUFDQSxJQUFJSyxLQUFLLEdBQUdMLE9BQU8sQ0FBQyxZQUFELENBQW5COztBQUNBLElB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QUFJLENBQUNjLE1BQU0sQ0FBQ25GLFNBQVAsQ0FBaUI0UCxjQUFqQixDQUFnQ0MsSUFBaEMsQ0FBcUNuUSxRQUFyQyxFQUErQzJFLFNBQS9DLENBQUwsRUFBZ0U7QUFDOUQzRSxNQUFBQSxRQUFRLENBQUMyRSxTQUFELENBQVIsR0FBc0JzTCxTQUF0QjtBQUNELEtBTHNELENBT3ZEOzs7QUFDQSxRQUFJalEsUUFBUSxDQUFDMkUsU0FBRCxDQUFSLElBQXVCM0UsUUFBUSxDQUFDMkUsU0FBRCxDQUFSLENBQW9CRyxJQUEvQyxFQUFxRDtBQUNuRCxhQUFPOUUsUUFBUSxDQUFDMkUsU0FBRCxDQUFmOztBQUNBLFVBQUlvTCxvQkFBb0IsSUFBSUUsU0FBUyxDQUFDbkwsSUFBVixJQUFrQixRQUE5QyxFQUF3RDtBQUN0RDlFLFFBQUFBLFFBQVEsQ0FBQzJFLFNBQUQsQ0FBUixHQUFzQnNMLFNBQXRCO0FBQ0Q7QUFDRjtBQUNGLEdBZEQ7QUFlQSxTQUFPalEsUUFBUDtBQUNELENBckJEOztlQXVCZWpCLFM7O0FBQ2ZxUixNQUFNLENBQUNDLE9BQVAsR0FBaUJ0UixTQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIi8vIEEgUmVzdFdyaXRlIGVuY2Fwc3VsYXRlcyBldmVyeXRoaW5nIHdlIG5lZWQgdG8gcnVuIGFuIG9wZXJhdGlvblxuLy8gdGhhdCB3cml0ZXMgdG8gdGhlIGRhdGFiYXNlLlxuLy8gVGhpcyBjb3VsZCBiZSBlaXRoZXIgYSBcImNyZWF0ZVwiIG9yIGFuIFwidXBkYXRlXCIuXG5cbnZhciBTY2hlbWFDb250cm9sbGVyID0gcmVxdWlyZSgnLi9Db250cm9sbGVycy9TY2hlbWFDb250cm9sbGVyJyk7XG52YXIgZGVlcGNvcHkgPSByZXF1aXJlKCdkZWVwY29weScpO1xuXG5jb25zdCBBdXRoID0gcmVxdWlyZSgnLi9BdXRoJyk7XG52YXIgY3J5cHRvVXRpbHMgPSByZXF1aXJlKCcuL2NyeXB0b1V0aWxzJyk7XG52YXIgcGFzc3dvcmRDcnlwdG8gPSByZXF1aXJlKCcuL3Bhc3N3b3JkJyk7XG52YXIgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJyk7XG52YXIgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG52YXIgQ2xpZW50U0RLID0gcmVxdWlyZSgnLi9DbGllbnRTREsnKTtcbmltcG9ydCBSZXN0UXVlcnkgZnJvbSAnLi9SZXN0UXVlcnknO1xuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi9sb2dnZXInO1xuXG4vLyBxdWVyeSBhbmQgZGF0YSBhcmUgYm90aCBwcm92aWRlZCBpbiBSRVNUIEFQSSBmb3JtYXQuIFNvIGRhdGFcbi8vIHR5cGVzIGFyZSBlbmNvZGVkIGJ5IHBsYWluIG9sZCBvYmplY3RzLlxuLy8gSWYgcXVlcnkgaXMgbnVsbCwgdGhpcyBpcyBhIFwiY3JlYXRlXCIgYW5kIHRoZSBkYXRhIGluIGRhdGEgc2hvdWxkIGJlXG4vLyBjcmVhdGVkLlxuLy8gT3RoZXJ3aXNlIHRoaXMgaXMgYW4gXCJ1cGRhdGVcIiAtIHRoZSBvYmplY3QgbWF0Y2hpbmcgdGhlIHF1ZXJ5XG4vLyBzaG91bGQgZ2V0IHVwZGF0ZWQgd2l0aCBkYXRhLlxuLy8gUmVzdFdyaXRlIHdpbGwgaGFuZGxlIG9iamVjdElkLCBjcmVhdGVkQXQsIGFuZCB1cGRhdGVkQXQgZm9yXG4vLyBldmVyeXRoaW5nLiBJdCBhbHNvIGtub3dzIHRvIHVzZSB0cmlnZ2VycyBhbmQgc3BlY2lhbCBtb2RpZmljYXRpb25zXG4vLyBmb3IgdGhlIF9Vc2VyIGNsYXNzLlxuZnVuY3Rpb24gUmVzdFdyaXRlKFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGNsYXNzTmFtZSxcbiAgcXVlcnksXG4gIGRhdGEsXG4gIG9yaWdpbmFsRGF0YSxcbiAgY2xpZW50U0RLXG4pIHtcbiAgaWYgKGF1dGguaXNSZWFkT25seSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAnQ2Fubm90IHBlcmZvcm0gYSB3cml0ZSBvcGVyYXRpb24gd2hlbiB1c2luZyByZWFkT25seU1hc3RlcktleSdcbiAgICApO1xuICB9XG4gIHRoaXMuY29uZmlnID0gY29uZmlnO1xuICB0aGlzLmF1dGggPSBhdXRoO1xuICB0aGlzLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgdGhpcy5jbGllbnRTREsgPSBjbGllbnRTREs7XG4gIHRoaXMuc3RvcmFnZSA9IHt9O1xuICB0aGlzLnJ1bk9wdGlvbnMgPSB7fTtcbiAgdGhpcy5jb250ZXh0ID0ge307XG4gIGlmICghcXVlcnkgJiYgZGF0YS5vYmplY3RJZCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAnb2JqZWN0SWQgaXMgYW4gaW52YWxpZCBmaWVsZCBuYW1lLidcbiAgICApO1xuICB9XG4gIGlmICghcXVlcnkgJiYgZGF0YS5pZCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAnaWQgaXMgYW4gaW52YWxpZCBmaWVsZCBuYW1lLidcbiAgICApO1xuICB9XG5cbiAgLy8gV2hlbiB0aGUgb3BlcmF0aW9uIGlzIGNvbXBsZXRlLCB0aGlzLnJlc3BvbnNlIG1heSBoYXZlIHNldmVyYWxcbiAgLy8gZmllbGRzLlxuICAvLyByZXNwb25zZTogdGhlIGFjdHVhbCBkYXRhIHRvIGJlIHJldHVybmVkXG4gIC8vIHN0YXR1czogdGhlIGh0dHAgc3RhdHVzIGNvZGUuIGlmIG5vdCBwcmVzZW50LCB0cmVhdGVkIGxpa2UgYSAyMDBcbiAgLy8gbG9jYXRpb246IHRoZSBsb2NhdGlvbiBoZWFkZXIuIGlmIG5vdCBwcmVzZW50LCBubyBsb2NhdGlvbiBoZWFkZXJcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG5cbiAgLy8gUHJvY2Vzc2luZyB0aGlzIG9wZXJhdGlvbiBtYXkgbXV0YXRlIG91ciBkYXRhLCBzbyB3ZSBvcGVyYXRlIG9uIGFcbiAgLy8gY29weVxuICB0aGlzLnF1ZXJ5ID0gZGVlcGNvcHkocXVlcnkpO1xuICB0aGlzLmRhdGEgPSBkZWVwY29weShkYXRhKTtcbiAgLy8gV2UgbmV2ZXIgY2hhbmdlIG9yaWdpbmFsRGF0YSwgc28gd2UgZG8gbm90IG5lZWQgYSBkZWVwIGNvcHlcbiAgdGhpcy5vcmlnaW5hbERhdGEgPSBvcmlnaW5hbERhdGE7XG5cbiAgLy8gVGhlIHRpbWVzdGFtcCB3ZSdsbCB1c2UgZm9yIHRoaXMgd2hvbGUgb3BlcmF0aW9uXG4gIHRoaXMudXBkYXRlZEF0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKS5pc287XG5cbiAgLy8gU2hhcmVkIFNjaGVtYUNvbnRyb2xsZXIgdG8gYmUgcmV1c2VkIHRvIHJlZHVjZSB0aGUgbnVtYmVyIG9mIGxvYWRTY2hlbWEoKSBjYWxscyBwZXIgcmVxdWVzdFxuICAvLyBPbmNlIHNldCB0aGUgc2NoZW1hRGF0YSBzaG91bGQgYmUgaW1tdXRhYmxlXG4gIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyID0gbnVsbDtcbn1cblxuLy8gQSBjb252ZW5pZW50IG1ldGhvZCB0byBwZXJmb3JtIGFsbCB0aGUgc3RlcHMgb2YgcHJvY2Vzc2luZyB0aGVcbi8vIHdyaXRlLCBpbiBvcmRlci5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIHtyZXNwb25zZSwgc3RhdHVzLCBsb2NhdGlvbn0gb2JqZWN0LlxuLy8gc3RhdHVzIGFuZCBsb2NhdGlvbiBhcmUgb3B0aW9uYWwuXG5SZXN0V3JpdGUucHJvdG90eXBlLmV4ZWN1dGUgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZ2V0VXNlckFuZFJvbGVBQ0woKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlSW5zdGFsbGF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVTZXNzaW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUF1dGhEYXRhKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5CZWZvcmVTYXZlVHJpZ2dlcigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlU2NoZW1hKCk7XG4gICAgfSlcbiAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyID0gc2NoZW1hQ29udHJvbGxlcjtcbiAgICAgIHJldHVybiB0aGlzLnNldFJlcXVpcmVkRmllbGRzSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnRyYW5zZm9ybVVzZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5EYXRhYmFzZU9wZXJhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5BZnRlclNhdmVUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jbGVhblVzZXJBdXRoRGF0YSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVzcG9uc2U7XG4gICAgfSk7XG59O1xuXG4vLyBVc2VzIHRoZSBBdXRoIG9iamVjdCB0byBnZXQgdGhlIGxpc3Qgb2Ygcm9sZXMsIGFkZHMgdGhlIHVzZXIgaWRcblJlc3RXcml0ZS5wcm90b3R5cGUuZ2V0VXNlckFuZFJvbGVBQ0wgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMucnVuT3B0aW9ucy5hY2wgPSBbJyonXTtcblxuICBpZiAodGhpcy5hdXRoLnVzZXIpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLmdldFVzZXJSb2xlcygpLnRoZW4ocm9sZXMgPT4ge1xuICAgICAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IHRoaXMucnVuT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbXG4gICAgICAgIHRoaXMuYXV0aC51c2VyLmlkLFxuICAgICAgXSk7XG4gICAgICByZXR1cm47XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIGNvbmZpZy5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uID0gZnVuY3Rpb24oKSB7XG4gIGlmIChcbiAgICB0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmXG4gICAgIXRoaXMuYXV0aC5pc01hc3RlciAmJlxuICAgIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTFcbiAgKSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgJ1RoaXMgdXNlciBpcyBub3QgYWxsb3dlZCB0byBhY2Nlc3MgJyArXG4gICAgICAgICAgICAgICdub24tZXhpc3RlbnQgY2xhc3M6ICcgK1xuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIHNjaGVtYS5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVTY2hlbWEgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnZhbGlkYXRlT2JqZWN0KFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRoaXMuZGF0YSxcbiAgICB0aGlzLnF1ZXJ5LFxuICAgIHRoaXMucnVuT3B0aW9uc1xuICApO1xufTtcblxuLy8gUnVucyBhbnkgYmVmb3JlU2F2ZSB0cmlnZ2VycyBhZ2FpbnN0IHRoaXMgb3BlcmF0aW9uLlxuLy8gQW55IGNoYW5nZSBsZWFkcyB0byBvdXIgZGF0YSBiZWluZyBtdXRhdGVkLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5CZWZvcmVTYXZlVHJpZ2dlciA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2JlZm9yZVNhdmUnIHRyaWdnZXIgZm9yIHRoaXMgY2xhc3MuXG4gIGlmIChcbiAgICAhdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgICApXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIC8vIENsb3VkIGNvZGUgZ2V0cyBhIGJpdCBvZiBleHRyYSBkYXRhIGZvciBpdHMgb2JqZWN0c1xuICB2YXIgZXh0cmFEYXRhID0geyBjbGFzc05hbWU6IHRoaXMuY2xhc3NOYW1lIH07XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBleHRyYURhdGEub2JqZWN0SWQgPSB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICB9XG5cbiAgbGV0IG9yaWdpbmFsT2JqZWN0ID0gbnVsbDtcbiAgY29uc3QgdXBkYXRlZE9iamVjdCA9IHRoaXMuYnVpbGRVcGRhdGVkT2JqZWN0KGV4dHJhRGF0YSk7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAvLyBUaGlzIGlzIGFuIHVwZGF0ZSBmb3IgZXhpc3Rpbmcgb2JqZWN0LlxuICAgIG9yaWdpbmFsT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgfVxuXG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIEJlZm9yZSBjYWxsaW5nIHRoZSB0cmlnZ2VyLCB2YWxpZGF0ZSB0aGUgcGVybWlzc2lvbnMgZm9yIHRoZSBzYXZlIG9wZXJhdGlvblxuICAgICAgbGV0IGRhdGFiYXNlUHJvbWlzZSA9IG51bGw7XG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgdXBkYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgY3JlYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UuY3JlYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgdHJ1ZVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gSW4gdGhlIGNhc2UgdGhhdCB0aGVyZSBpcyBubyBwZXJtaXNzaW9uIGZvciB0aGUgb3BlcmF0aW9uLCBpdCB0aHJvd3MgYW4gZXJyb3JcbiAgICAgIHJldHVybiBkYXRhYmFzZVByb21pc2UudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICBpZiAoIXJlc3VsdCB8fCByZXN1bHQubGVuZ3RoIDw9IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgICAgJ09iamVjdCBub3QgZm91bmQuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyaWdnZXJzLm1heWJlUnVuVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgICAgdGhpcy5hdXRoLFxuICAgICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgdGhpcy5jb25maWcsXG4gICAgICAgIHRoaXMuY29udGV4dFxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSBfLnJlZHVjZShcbiAgICAgICAgICByZXNwb25zZS5vYmplY3QsXG4gICAgICAgICAgKHJlc3VsdCwgdmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRXF1YWwodGhpcy5kYXRhW2tleV0sIHZhbHVlKSkge1xuICAgICAgICAgICAgICByZXN1bHQucHVzaChrZXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICB9LFxuICAgICAgICAgIFtdXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGF0YSA9IHJlc3BvbnNlLm9iamVjdDtcbiAgICAgICAgLy8gV2Ugc2hvdWxkIGRlbGV0ZSB0aGUgb2JqZWN0SWQgZm9yIGFuIHVwZGF0ZSB3cml0ZVxuICAgICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5CZWZvcmVMb2dpblRyaWdnZXIgPSBhc3luYyBmdW5jdGlvbih1c2VyRGF0YSkge1xuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdiZWZvcmVMb2dpbicgdHJpZ2dlclxuICBpZiAoXG4gICAgIXRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUxvZ2luLFxuICAgICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICAgIClcbiAgKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQ2xvdWQgY29kZSBnZXRzIGEgYml0IG9mIGV4dHJhIGRhdGEgZm9yIGl0cyBvYmplY3RzXG4gIGNvbnN0IGV4dHJhRGF0YSA9IHsgY2xhc3NOYW1lOiB0aGlzLmNsYXNzTmFtZSB9O1xuICBjb25zdCB1c2VyID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHVzZXJEYXRhKTtcblxuICAvLyBubyBuZWVkIHRvIHJldHVybiBhIHJlc3BvbnNlXG4gIGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuVHJpZ2dlcihcbiAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVMb2dpbixcbiAgICB0aGlzLmF1dGgsXG4gICAgdXNlcixcbiAgICBudWxsLFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuY29udGV4dFxuICApO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5zZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmRhdGEpIHtcbiAgICByZXR1cm4gdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIuZ2V0QWxsQ2xhc3NlcygpLnRoZW4oYWxsQ2xhc3NlcyA9PiB7XG4gICAgICBjb25zdCBzY2hlbWEgPSBhbGxDbGFzc2VzLmZpbmQoXG4gICAgICAgIG9uZUNsYXNzID0+IG9uZUNsYXNzLmNsYXNzTmFtZSA9PT0gdGhpcy5jbGFzc05hbWVcbiAgICAgICk7XG4gICAgICBjb25zdCBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQgPSAoZmllbGROYW1lLCBzZXREZWZhdWx0KSA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkIHx8XG4gICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IG51bGwgfHxcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gJycgfHxcbiAgICAgICAgICAodHlwZW9mIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0uX19vcCA9PT0gJ0RlbGV0ZScpXG4gICAgICAgICkge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHNldERlZmF1bHQgJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZSAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZSAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICAgICAodGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IHVuZGVmaW5lZCB8fFxuICAgICAgICAgICAgICAodHlwZW9mIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdLl9fb3AgPT09ICdEZWxldGUnKSlcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID0gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZTtcbiAgICAgICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyID1cbiAgICAgICAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgfHwgW107XG4gICAgICAgICAgICBpZiAodGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuaW5kZXhPZihmaWVsZE5hbWUpIDwgMCkge1xuICAgICAgICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJlcXVpcmVkID09PSB0cnVlXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgIGAke2ZpZWxkTmFtZX0gaXMgcmVxdWlyZWRgXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgY29uc3QgYXNzaWduT2JqZWN0SWQgPSAoKSA9PiB7XG4gICAgICAgIGNvbnN0IG9iamVjdElkID0gY3J5cHRvVXRpbHMubmV3T2JqZWN0SWQodGhpcy5jb25maWcub2JqZWN0SWRTaXplLCB0aGlzLmNvbmZpZy5vYmplY3RJZFVzZVRpbWUpO1xuICAgICAgICBpZiAoIXRoaXMuY29uZmlnLm9iamVjdElkUHJlZml4ZXMpIHtcbiAgICAgICAgICByZXR1cm4gb2JqZWN0SWQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLm9iamVjdElkUHJlZml4ZXNbdGhpcy5jbGFzc05hbWVdXG4gICAgICAgICAgPyBgJHt0aGlzLmNvbmZpZy5vYmplY3RJZFByZWZpeGVzW3RoaXMuY2xhc3NOYW1lXX0ke29iamVjdElkfWBcbiAgICAgICAgICA6IG9iamVjdElkO1xuICAgICAgfTtcblxuICAgICAgLy8gQWRkIGRlZmF1bHQgZmllbGRzXG4gICAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuXG4gICAgICAgIC8vIE9ubHkgYXNzaWduIG5ldyBvYmplY3RJZCBpZiB3ZSBhcmUgY3JlYXRpbmcgbmV3IG9iamVjdFxuICAgICAgICBpZiAoIXRoaXMuZGF0YS5vYmplY3RJZCkge1xuICAgICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCA9IGFzc2lnbk9iamVjdElkKCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNjaGVtYSkge1xuICAgICAgICAgIE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgIHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZChmaWVsZE5hbWUsIHRydWUpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHNjaGVtYSkge1xuICAgICAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQoZmllbGROYW1lLCBmYWxzZSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cbi8vIFRyYW5zZm9ybXMgYXV0aCBkYXRhIGZvciBhIHVzZXIgb2JqZWN0LlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYSB1c2VyIG9iamVjdC5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVBdXRoRGF0YSA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIXRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIGlmIChcbiAgICAgIHR5cGVvZiB0aGlzLmRhdGEudXNlcm5hbWUgIT09ICdzdHJpbmcnIHx8XG4gICAgICBfLmlzRW1wdHkodGhpcy5kYXRhLnVzZXJuYW1lKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9NSVNTSU5HLFxuICAgICAgICAnYmFkIG9yIG1pc3NpbmcgdXNlcm5hbWUnXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICB0eXBlb2YgdGhpcy5kYXRhLnBhc3N3b3JkICE9PSAnc3RyaW5nJyB8fFxuICAgICAgXy5pc0VtcHR5KHRoaXMuZGF0YS5wYXNzd29yZClcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuUEFTU1dPUkRfTUlTU0lORyxcbiAgICAgICAgJ3Bhc3N3b3JkIGlzIHJlcXVpcmVkJ1xuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBpZiAoIXRoaXMuZGF0YS5hdXRoRGF0YSB8fCAhT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGgpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB2YXIgYXV0aERhdGEgPSB0aGlzLmRhdGEuYXV0aERhdGE7XG4gIHZhciBwcm92aWRlcnMgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSk7XG4gIGlmIChwcm92aWRlcnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGNhbkhhbmRsZUF1dGhEYXRhID0gcHJvdmlkZXJzLnJlZHVjZSgoY2FuSGFuZGxlLCBwcm92aWRlcikgPT4ge1xuICAgICAgdmFyIHByb3ZpZGVyQXV0aERhdGEgPSBhdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICB2YXIgaGFzVG9rZW4gPSBwcm92aWRlckF1dGhEYXRhICYmIHByb3ZpZGVyQXV0aERhdGEuaWQ7XG4gICAgICByZXR1cm4gY2FuSGFuZGxlICYmIChoYXNUb2tlbiB8fCBwcm92aWRlckF1dGhEYXRhID09IG51bGwpO1xuICAgIH0sIHRydWUpO1xuICAgIGlmIChjYW5IYW5kbGVBdXRoRGF0YSkge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlQXV0aERhdGEoYXV0aERhdGEpO1xuICAgIH1cbiAgfVxuICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgUGFyc2UuRXJyb3IuVU5TVVBQT1JURURfU0VSVklDRSxcbiAgICAnVGhpcyBhdXRoZW50aWNhdGlvbiBtZXRob2QgaXMgdW5zdXBwb3J0ZWQuJ1xuICApO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24gPSBmdW5jdGlvbihhdXRoRGF0YSkge1xuICBjb25zdCB2YWxpZGF0aW9ucyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKS5tYXAocHJvdmlkZXIgPT4ge1xuICAgIGlmIChhdXRoRGF0YVtwcm92aWRlcl0gPT09IG51bGwpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgdmFsaWRhdGVBdXRoRGF0YSA9IHRoaXMuY29uZmlnLmF1dGhEYXRhTWFuYWdlci5nZXRWYWxpZGF0b3JGb3JQcm92aWRlcihcbiAgICAgIHByb3ZpZGVyXG4gICAgKTtcbiAgICBpZiAoIXZhbGlkYXRlQXV0aERhdGEpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuVU5TVVBQT1JURURfU0VSVklDRSxcbiAgICAgICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLidcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB2YWxpZGF0ZUF1dGhEYXRhKGF1dGhEYXRhW3Byb3ZpZGVyXSk7XG4gIH0pO1xuICByZXR1cm4gUHJvbWlzZS5hbGwodmFsaWRhdGlvbnMpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5maW5kVXNlcnNXaXRoQXV0aERhdGEgPSBmdW5jdGlvbihhdXRoRGF0YSkge1xuICBjb25zdCBwcm92aWRlcnMgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSk7XG4gIGNvbnN0IHF1ZXJ5ID0gcHJvdmlkZXJzXG4gICAgLnJlZHVjZSgobWVtbywgcHJvdmlkZXIpID0+IHtcbiAgICAgIGlmICghYXV0aERhdGFbcHJvdmlkZXJdKSB7XG4gICAgICAgIHJldHVybiBtZW1vO1xuICAgICAgfVxuICAgICAgY29uc3QgcXVlcnlLZXkgPSBgYXV0aERhdGEuJHtwcm92aWRlcn0uaWRgO1xuICAgICAgY29uc3QgcXVlcnkgPSB7fTtcbiAgICAgIHF1ZXJ5W3F1ZXJ5S2V5XSA9IGF1dGhEYXRhW3Byb3ZpZGVyXS5pZDtcbiAgICAgIG1lbW8ucHVzaChxdWVyeSk7XG4gICAgICByZXR1cm4gbWVtbztcbiAgICB9LCBbXSlcbiAgICAuZmlsdGVyKHEgPT4ge1xuICAgICAgcmV0dXJuIHR5cGVvZiBxICE9PSAndW5kZWZpbmVkJztcbiAgICB9KTtcblxuICBsZXQgZmluZFByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoW10pO1xuICBpZiAocXVlcnkubGVuZ3RoID4gMCkge1xuICAgIGZpbmRQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZCh0aGlzLmNsYXNzTmFtZSwgeyAkb3I6IHF1ZXJ5IH0sIHt9KTtcbiAgfVxuXG4gIHJldHVybiBmaW5kUHJvbWlzZTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZmlsdGVyZWRPYmplY3RzQnlBQ0wgPSBmdW5jdGlvbihvYmplY3RzKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXR1cm4gb2JqZWN0cztcbiAgfVxuICByZXR1cm4gb2JqZWN0cy5maWx0ZXIob2JqZWN0ID0+IHtcbiAgICBpZiAoIW9iamVjdC5BQ0wpIHtcbiAgICAgIHJldHVybiB0cnVlOyAvLyBsZWdhY3kgdXNlcnMgdGhhdCBoYXZlIG5vIEFDTCBmaWVsZCBvbiB0aGVtXG4gICAgfVxuICAgIC8vIFJlZ3VsYXIgdXNlcnMgdGhhdCBoYXZlIGJlZW4gbG9ja2VkIG91dC5cbiAgICByZXR1cm4gb2JqZWN0LkFDTCAmJiBPYmplY3Qua2V5cyhvYmplY3QuQUNMKS5sZW5ndGggPiAwO1xuICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlQXV0aERhdGEgPSBmdW5jdGlvbihhdXRoRGF0YSkge1xuICBsZXQgcmVzdWx0cztcbiAgcmV0dXJuIHRoaXMuZmluZFVzZXJzV2l0aEF1dGhEYXRhKGF1dGhEYXRhKS50aGVuKGFzeW5jIHIgPT4ge1xuICAgIHJlc3VsdHMgPSB0aGlzLmZpbHRlcmVkT2JqZWN0c0J5QUNMKHIpO1xuXG4gICAgaWYgKHJlc3VsdHMubGVuZ3RoID09IDEpIHtcbiAgICAgIHRoaXMuc3RvcmFnZVsnYXV0aFByb3ZpZGVyJ10gPSBPYmplY3Qua2V5cyhhdXRoRGF0YSkuam9pbignLCcpO1xuXG4gICAgICBjb25zdCB1c2VyUmVzdWx0ID0gcmVzdWx0c1swXTtcbiAgICAgIGNvbnN0IG11dGF0ZWRBdXRoRGF0YSA9IHt9O1xuICAgICAgT2JqZWN0LmtleXMoYXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICBjb25zdCBwcm92aWRlckRhdGEgPSBhdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICAgIGNvbnN0IHVzZXJBdXRoRGF0YSA9IHVzZXJSZXN1bHQuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICBpZiAoIV8uaXNFcXVhbChwcm92aWRlckRhdGEsIHVzZXJBdXRoRGF0YSkpIHtcbiAgICAgICAgICBtdXRhdGVkQXV0aERhdGFbcHJvdmlkZXJdID0gcHJvdmlkZXJEYXRhO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGhhc011dGF0ZWRBdXRoRGF0YSA9IE9iamVjdC5rZXlzKG11dGF0ZWRBdXRoRGF0YSkubGVuZ3RoICE9PSAwO1xuICAgICAgbGV0IHVzZXJJZDtcbiAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgdXNlcklkID0gdGhpcy5xdWVyeS5vYmplY3RJZDtcbiAgICAgIH0gZWxzZSBpZiAodGhpcy5hdXRoICYmIHRoaXMuYXV0aC51c2VyICYmIHRoaXMuYXV0aC51c2VyLmlkKSB7XG4gICAgICAgIHVzZXJJZCA9IHRoaXMuYXV0aC51c2VyLmlkO1xuICAgICAgfVxuICAgICAgaWYgKCF1c2VySWQgfHwgdXNlcklkID09PSB1c2VyUmVzdWx0Lm9iamVjdElkKSB7XG4gICAgICAgIC8vIG5vIHVzZXIgbWFraW5nIHRoZSBjYWxsXG4gICAgICAgIC8vIE9SIHRoZSB1c2VyIG1ha2luZyB0aGUgY2FsbCBpcyB0aGUgcmlnaHQgb25lXG4gICAgICAgIC8vIExvZ2luIHdpdGggYXV0aCBkYXRhXG4gICAgICAgIGRlbGV0ZSByZXN1bHRzWzBdLnBhc3N3b3JkO1xuXG4gICAgICAgIC8vIG5lZWQgdG8gc2V0IHRoZSBvYmplY3RJZCBmaXJzdCBvdGhlcndpc2UgbG9jYXRpb24gaGFzIHRyYWlsaW5nIHVuZGVmaW5lZFxuICAgICAgICB0aGlzLmRhdGEub2JqZWN0SWQgPSB1c2VyUmVzdWx0Lm9iamVjdElkO1xuXG4gICAgICAgIGlmICghdGhpcy5xdWVyeSB8fCAhdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICAgIC8vIHRoaXMgYSBsb2dpbiBjYWxsLCBubyB1c2VySWQgcGFzc2VkXG4gICAgICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgICAgIHJlc3BvbnNlOiB1c2VyUmVzdWx0LFxuICAgICAgICAgICAgbG9jYXRpb246IHRoaXMubG9jYXRpb24oKSxcbiAgICAgICAgICB9O1xuICAgICAgICAgIC8vIFJ1biBiZWZvcmVMb2dpbiBob29rIGJlZm9yZSBzdG9yaW5nIGFueSB1cGRhdGVzXG4gICAgICAgICAgLy8gdG8gYXV0aERhdGEgb24gdGhlIGRiOyBjaGFuZ2VzIHRvIHVzZXJSZXN1bHRcbiAgICAgICAgICAvLyB3aWxsIGJlIGlnbm9yZWQuXG4gICAgICAgICAgYXdhaXQgdGhpcy5ydW5CZWZvcmVMb2dpblRyaWdnZXIoZGVlcGNvcHkodXNlclJlc3VsdCkpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgd2UgZGlkbid0IGNoYW5nZSB0aGUgYXV0aCBkYXRhLCBqdXN0IGtlZXAgZ29pbmdcbiAgICAgICAgaWYgKCFoYXNNdXRhdGVkQXV0aERhdGEpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgLy8gV2UgaGF2ZSBhdXRoRGF0YSB0aGF0IGlzIHVwZGF0ZWQgb24gbG9naW5cbiAgICAgICAgLy8gdGhhdCBjYW4gaGFwcGVuIHdoZW4gdG9rZW4gYXJlIHJlZnJlc2hlZCxcbiAgICAgICAgLy8gV2Ugc2hvdWxkIHVwZGF0ZSB0aGUgdG9rZW4gYW5kIGxldCB0aGUgdXNlciBpblxuICAgICAgICAvLyBXZSBzaG91bGQgb25seSBjaGVjayB0aGUgbXV0YXRlZCBrZXlzXG4gICAgICAgIHJldHVybiB0aGlzLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihtdXRhdGVkQXV0aERhdGEpLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIC8vIElGIHdlIGhhdmUgYSByZXNwb25zZSwgd2UnbGwgc2tpcCB0aGUgZGF0YWJhc2Ugb3BlcmF0aW9uIC8gYmVmb3JlU2F2ZSAvIGFmdGVyU2F2ZSBldGMuLi5cbiAgICAgICAgICAvLyB3ZSBuZWVkIHRvIHNldCBpdCB1cCB0aGVyZS5cbiAgICAgICAgICAvLyBXZSBhcmUgc3VwcG9zZWQgdG8gaGF2ZSBhIHJlc3BvbnNlIG9ubHkgb24gTE9HSU4gd2l0aCBhdXRoRGF0YSwgc28gd2Ugc2tpcCB0aG9zZVxuICAgICAgICAgIC8vIElmIHdlJ3JlIG5vdCBsb2dnaW5nIGluLCBidXQganVzdCB1cGRhdGluZyB0aGUgY3VycmVudCB1c2VyLCB3ZSBjYW4gc2FmZWx5IHNraXAgdGhhdCBwYXJ0XG4gICAgICAgICAgaWYgKHRoaXMucmVzcG9uc2UpIHtcbiAgICAgICAgICAgIC8vIEFzc2lnbiB0aGUgbmV3IGF1dGhEYXRhIGluIHRoZSByZXNwb25zZVxuICAgICAgICAgICAgT2JqZWN0LmtleXMobXV0YXRlZEF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgICAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5hdXRoRGF0YVtwcm92aWRlcl0gPVxuICAgICAgICAgICAgICAgIG11dGF0ZWRBdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gUnVuIHRoZSBEQiB1cGRhdGUgZGlyZWN0bHksIGFzICdtYXN0ZXInXG4gICAgICAgICAgICAvLyBKdXN0IHVwZGF0ZSB0aGUgYXV0aERhdGEgcGFydFxuICAgICAgICAgICAgLy8gVGhlbiB3ZSdyZSBnb29kIGZvciB0aGUgdXNlciwgZWFybHkgZXhpdCBvZiBzb3J0c1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZShcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMuZGF0YS5vYmplY3RJZCB9LFxuICAgICAgICAgICAgICB7IGF1dGhEYXRhOiBtdXRhdGVkQXV0aERhdGEgfSxcbiAgICAgICAgICAgICAge31cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAodXNlcklkKSB7XG4gICAgICAgIC8vIFRyeWluZyB0byB1cGRhdGUgYXV0aCBkYXRhIGJ1dCB1c2Vyc1xuICAgICAgICAvLyBhcmUgZGlmZmVyZW50XG4gICAgICAgIGlmICh1c2VyUmVzdWx0Lm9iamVjdElkICE9PSB1c2VySWQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELFxuICAgICAgICAgICAgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBObyBhdXRoIGRhdGEgd2FzIG11dGF0ZWQsIGp1c3Qga2VlcCBnb2luZ1xuICAgICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24oYXV0aERhdGEpLnRoZW4oKCkgPT4ge1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMSkge1xuICAgICAgICAvLyBNb3JlIHRoYW4gMSB1c2VyIHdpdGggdGhlIHBhc3NlZCBpZCdzXG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELFxuICAgICAgICAgICd0aGlzIGF1dGggaXMgYWxyZWFkeSB1c2VkJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcbn07XG5cbi8vIFRoZSBub24tdGhpcmQtcGFydHkgcGFydHMgb2YgVXNlciB0cmFuc2Zvcm1hdGlvblxuUmVzdFdyaXRlLnByb3RvdHlwZS50cmFuc2Zvcm1Vc2VyID0gZnVuY3Rpb24oKSB7XG4gIHZhciBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cblxuICBpZiAoIXRoaXMuYXV0aC5pc01hc3RlciAmJiAnZW1haWxWZXJpZmllZCcgaW4gdGhpcy5kYXRhKSB7XG4gICAgY29uc3QgZXJyb3IgPSBgQ2xpZW50cyBhcmVuJ3QgYWxsb3dlZCB0byBtYW51YWxseSB1cGRhdGUgZW1haWwgdmVyaWZpY2F0aW9uLmA7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sIGVycm9yKTtcbiAgfVxuXG4gIC8vIERvIG5vdCBjbGVhbnVwIHNlc3Npb24gaWYgb2JqZWN0SWQgaXMgbm90IHNldFxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLm9iamVjdElkKCkpIHtcbiAgICAvLyBJZiB3ZSdyZSB1cGRhdGluZyBhIF9Vc2VyIG9iamVjdCwgd2UgbmVlZCB0byBjbGVhciBvdXQgdGhlIGNhY2hlIGZvciB0aGF0IHVzZXIuIEZpbmQgYWxsIHRoZWlyXG4gICAgLy8gc2Vzc2lvbiB0b2tlbnMsIGFuZCByZW1vdmUgdGhlbSBmcm9tIHRoZSBjYWNoZS5cbiAgICBwcm9taXNlID0gbmV3IFJlc3RRdWVyeSh0aGlzLmNvbmZpZywgQXV0aC5tYXN0ZXIodGhpcy5jb25maWcpLCAnX1Nlc3Npb24nLCB7XG4gICAgICB1c2VyOiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICB9LFxuICAgIH0pXG4gICAgICAuZXhlY3V0ZSgpXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgcmVzdWx0cy5yZXN1bHRzLmZvckVhY2goc2Vzc2lvbiA9PlxuICAgICAgICAgIHRoaXMuY29uZmlnLmNhY2hlQ29udHJvbGxlci51c2VyLmRlbChzZXNzaW9uLnNlc3Npb25Ub2tlbilcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHByb21pc2VcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICAvLyBUcmFuc2Zvcm0gdGhlIHBhc3N3b3JkXG4gICAgICBpZiAodGhpcy5kYXRhLnBhc3N3b3JkID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgLy8gaWdub3JlIG9ubHkgaWYgdW5kZWZpbmVkLiBzaG91bGQgcHJvY2VlZCBpZiBlbXB0eSAoJycpXG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICAgICAgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ10gPSB0cnVlO1xuICAgICAgICAvLyBHZW5lcmF0ZSBhIG5ldyBzZXNzaW9uIG9ubHkgaWYgdGhlIHVzZXIgcmVxdWVzdGVkXG4gICAgICAgIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgICAgICAgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXSA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3koKS50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHBhc3N3b3JkQ3J5cHRvLmhhc2godGhpcy5kYXRhLnBhc3N3b3JkKS50aGVuKGhhc2hlZFBhc3N3b3JkID0+IHtcbiAgICAgICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCA9IGhhc2hlZFBhc3N3b3JkO1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEucGFzc3dvcmQ7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVVc2VyTmFtZSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlRW1haWwoKTtcbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlVXNlck5hbWUgPSBmdW5jdGlvbigpIHtcbiAgLy8gQ2hlY2sgZm9yIHVzZXJuYW1lIHVuaXF1ZW5lc3NcbiAgaWYgKCF0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgIHRoaXMuZGF0YS51c2VybmFtZSA9IGNyeXB0b1V0aWxzLnJhbmRvbVN0cmluZygyNSk7XG4gICAgICB0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFdlIG5lZWQgdG8gYSBmaW5kIHRvIGNoZWNrIGZvciBkdXBsaWNhdGUgdXNlcm5hbWUgaW4gY2FzZSB0aGV5IGFyZSBtaXNzaW5nIHRoZSB1bmlxdWUgaW5kZXggb24gdXNlcm5hbWVzXG4gIC8vIFRPRE86IENoZWNrIGlmIHRoZXJlIGlzIGEgdW5pcXVlIGluZGV4LCBhbmQgaWYgc28sIHNraXAgdGhpcyBxdWVyeS5cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHsgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSwgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSB9LFxuICAgICAgeyBsaW1pdDogMSB9LFxuICAgICAge30sXG4gICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgIClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOLFxuICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlRW1haWwgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLmRhdGEuZW1haWwgfHwgdGhpcy5kYXRhLmVtYWlsLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFZhbGlkYXRlIGJhc2ljIGVtYWlsIGFkZHJlc3MgZm9ybWF0XG4gIGlmICghdGhpcy5kYXRhLmVtYWlsLm1hdGNoKC9eLitALiskLykpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfRU1BSUxfQUREUkVTUyxcbiAgICAgICAgJ0VtYWlsIGFkZHJlc3MgZm9ybWF0IGlzIGludmFsaWQuJ1xuICAgICAgKVxuICAgICk7XG4gIH1cbiAgLy8gU2FtZSBwcm9ibGVtIGZvciBlbWFpbCBhcyBhYm92ZSBmb3IgdXNlcm5hbWVcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHsgZW1haWw6IHRoaXMuZGF0YS5lbWFpbCwgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSB9LFxuICAgICAgeyBsaW1pdDogMSB9LFxuICAgICAge30sXG4gICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgIClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICAhdGhpcy5kYXRhLmF1dGhEYXRhIHx8XG4gICAgICAgICFPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCB8fFxuICAgICAgICAoT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGggPT09IDEgJiZcbiAgICAgICAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpWzBdID09PSAnYW5vbnltb3VzJylcbiAgICAgICkge1xuICAgICAgICAvLyBXZSB1cGRhdGVkIHRoZSBlbWFpbCwgc2VuZCBhIG5ldyB2YWxpZGF0aW9uXG4gICAgICAgIHRoaXMuc3RvcmFnZVsnc2VuZFZlcmlmaWNhdGlvbkVtYWlsJ10gPSB0cnVlO1xuICAgICAgICB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZXRFbWFpbFZlcmlmeVRva2VuKHRoaXMuZGF0YSk7XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkUG9saWN5ID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kpIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMoKS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkoKTtcbiAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzID0gZnVuY3Rpb24oKSB7XG4gIC8vIGNoZWNrIGlmIHRoZSBwYXNzd29yZCBjb25mb3JtcyB0byB0aGUgZGVmaW5lZCBwYXNzd29yZCBwb2xpY3kgaWYgY29uZmlndXJlZFxuICAvLyBJZiB3ZSBzcGVjaWZpZWQgYSBjdXN0b20gZXJyb3IgaW4gb3VyIGNvbmZpZ3VyYXRpb24gdXNlIGl0LlxuICAvLyBFeGFtcGxlOiBcIlBhc3N3b3JkcyBtdXN0IGluY2x1ZGUgYSBDYXBpdGFsIExldHRlciwgTG93ZXJjYXNlIExldHRlciwgYW5kIGEgbnVtYmVyLlwiXG4gIC8vXG4gIC8vIFRoaXMgaXMgZXNwZWNpYWxseSB1c2VmdWwgb24gdGhlIGdlbmVyaWMgXCJwYXNzd29yZCByZXNldFwiIHBhZ2UsXG4gIC8vIGFzIGl0IGFsbG93cyB0aGUgcHJvZ3JhbW1lciB0byBjb21tdW5pY2F0ZSBzcGVjaWZpYyByZXF1aXJlbWVudHMgaW5zdGVhZCBvZjpcbiAgLy8gYS4gbWFraW5nIHRoZSB1c2VyIGd1ZXNzIHdoYXRzIHdyb25nXG4gIC8vIGIuIG1ha2luZyBhIGN1c3RvbSBwYXNzd29yZCByZXNldCBwYWdlIHRoYXQgc2hvd3MgdGhlIHJlcXVpcmVtZW50c1xuICBjb25zdCBwb2xpY3lFcnJvciA9IHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRpb25FcnJvclxuICAgID8gdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdGlvbkVycm9yXG4gICAgOiAnUGFzc3dvcmQgZG9lcyBub3QgbWVldCB0aGUgUGFzc3dvcmQgUG9saWN5IHJlcXVpcmVtZW50cy4nO1xuICBjb25zdCBjb250YWluc1VzZXJuYW1lRXJyb3IgPSAnUGFzc3dvcmQgY2Fubm90IGNvbnRhaW4geW91ciB1c2VybmFtZS4nO1xuXG4gIC8vIGNoZWNrIHdoZXRoZXIgdGhlIHBhc3N3b3JkIG1lZXRzIHRoZSBwYXNzd29yZCBzdHJlbmd0aCByZXF1aXJlbWVudHNcbiAgaWYgKFxuICAgICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yICYmXG4gICAgICAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kucGF0dGVyblZhbGlkYXRvcih0aGlzLmRhdGEucGFzc3dvcmQpKSB8fFxuICAgICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayAmJlxuICAgICAgIXRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRvckNhbGxiYWNrKHRoaXMuZGF0YS5wYXNzd29yZCkpXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBwb2xpY3lFcnJvcilcbiAgICApO1xuICB9XG5cbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBjb250YWluIHVzZXJuYW1lXG4gIGlmICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgPT09IHRydWUpIHtcbiAgICBpZiAodGhpcy5kYXRhLnVzZXJuYW1lKSB7XG4gICAgICAvLyB1c2VybmFtZSBpcyBub3QgcGFzc2VkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHRoaXMuZGF0YS51c2VybmFtZSkgPj0gMClcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBjb250YWluc1VzZXJuYW1lRXJyb3IpXG4gICAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHJldHJpZXZlIHRoZSBVc2VyIG9iamVjdCB1c2luZyBvYmplY3RJZCBkdXJpbmcgcGFzc3dvcmQgcmVzZXRcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAuZmluZCgnX1VzZXInLCB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSlcbiAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICAgIHRocm93IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHJlc3VsdHNbMF0udXNlcm5hbWUpID49IDApXG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgIGNvbnRhaW5zVXNlcm5hbWVFcnJvclxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApO1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5ID0gZnVuY3Rpb24oKSB7XG4gIC8vIGNoZWNrIHdoZXRoZXIgcGFzc3dvcmQgaXMgcmVwZWF0aW5nIGZyb20gc3BlY2lmaWVkIGhpc3RvcnlcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5KSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuZmluZChcbiAgICAgICAgJ19Vc2VyJyxcbiAgICAgICAgeyBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgIHsga2V5czogWydfcGFzc3dvcmRfaGlzdG9yeScsICdfaGFzaGVkX3Bhc3N3b3JkJ10gfVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICBsZXQgb2xkUGFzc3dvcmRzID0gW107XG4gICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KVxuICAgICAgICAgIG9sZFBhc3N3b3JkcyA9IF8udGFrZShcbiAgICAgICAgICAgIHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksXG4gICAgICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgLSAxXG4gICAgICAgICAgKTtcbiAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgIGNvbnN0IG5ld1Bhc3N3b3JkID0gdGhpcy5kYXRhLnBhc3N3b3JkO1xuICAgICAgICAvLyBjb21wYXJlIHRoZSBuZXcgcGFzc3dvcmQgaGFzaCB3aXRoIGFsbCBvbGQgcGFzc3dvcmQgaGFzaGVzXG4gICAgICAgIGNvbnN0IHByb21pc2VzID0gb2xkUGFzc3dvcmRzLm1hcChmdW5jdGlvbihoYXNoKSB7XG4gICAgICAgICAgcmV0dXJuIHBhc3N3b3JkQ3J5cHRvLmNvbXBhcmUobmV3UGFzc3dvcmQsIGhhc2gpLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHQpXG4gICAgICAgICAgICAgIC8vIHJlamVjdCBpZiB0aGVyZSBpcyBhIG1hdGNoXG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdCgnUkVQRUFUX1BBU1NXT1JEJyk7XG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgICAvLyB3YWl0IGZvciBhbGwgY29tcGFyaXNvbnMgdG8gY29tcGxldGVcbiAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKVxuICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgaWYgKGVyciA9PT0gJ1JFUEVBVF9QQVNTV09SRCcpXG4gICAgICAgICAgICAgIC8vIGEgbWF0Y2ggd2FzIGZvdW5kXG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgICAgYE5ldyBwYXNzd29yZCBzaG91bGQgbm90IGJlIHRoZSBzYW1lIGFzIGxhc3QgJHt0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3Rvcnl9IHBhc3N3b3Jkcy5gXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gRG9uJ3QgZ2VuZXJhdGUgc2Vzc2lvbiBmb3IgdXBkYXRpbmcgdXNlciAodGhpcy5xdWVyeSBpcyBzZXQpIHVubGVzcyBhdXRoRGF0YSBleGlzdHNcbiAgaWYgKHRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEb24ndCBnZW5lcmF0ZSBuZXcgc2Vzc2lvblRva2VuIGlmIGxpbmtpbmcgdmlhIHNlc3Npb25Ub2tlblxuICBpZiAodGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChcbiAgICAhdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSAmJiAvLyBzaWdudXAgY2FsbCwgd2l0aFxuICAgIHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgJiYgLy8gbm8gbG9naW4gd2l0aG91dCB2ZXJpZmljYXRpb25cbiAgICB0aGlzLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzXG4gICkge1xuICAgIC8vIHZlcmlmaWNhdGlvbiBpcyBvblxuICAgIHJldHVybjsgLy8gZG8gbm90IGNyZWF0ZSB0aGUgc2Vzc2lvbiB0b2tlbiBpbiB0aGF0IGNhc2UhXG4gIH1cbiAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNyZWF0ZVNlc3Npb25Ub2tlbiA9IGFzeW5jIGZ1bmN0aW9uKCkge1xuICAvLyBjbG91ZCBpbnN0YWxsYXRpb25JZCBmcm9tIENsb3VkIENvZGUsXG4gIC8vIG5ldmVyIGNyZWF0ZSBzZXNzaW9uIHRva2VucyBmcm9tIHRoZXJlLlxuICBpZiAodGhpcy5hdXRoLmluc3RhbGxhdGlvbklkICYmIHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCA9PT0gJ2Nsb3VkJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IEF1dGguY3JlYXRlU2Vzc2lvbih0aGlzLmNvbmZpZywge1xuICAgIHVzZXJJZDogdGhpcy5vYmplY3RJZCgpLFxuICAgIGNyZWF0ZWRXaXRoOiB7XG4gICAgICBhY3Rpb246IHRoaXMuc3RvcmFnZVsnYXV0aFByb3ZpZGVyJ10gPyAnbG9naW4nIDogJ3NpZ251cCcsXG4gICAgICBhdXRoUHJvdmlkZXI6IHRoaXMuc3RvcmFnZVsnYXV0aFByb3ZpZGVyJ10gfHwgJ3Bhc3N3b3JkJyxcbiAgICB9LFxuICAgIGluc3RhbGxhdGlvbklkOiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gIH0pO1xuXG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLnNlc3Npb25Ub2tlbiA9IHNlc3Npb25EYXRhLnNlc3Npb25Ub2tlbjtcbiAgfVxuXG4gIHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG59O1xuXG4vLyBEZWxldGUgZW1haWwgcmVzZXQgdG9rZW5zIGlmIHVzZXIgaXMgY2hhbmdpbmcgcGFzc3dvcmQgb3IgZW1haWwuXG5SZXN0V3JpdGUucHJvdG90eXBlLmRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCB0aGlzLnF1ZXJ5ID09PSBudWxsKSB7XG4gICAgLy8gbnVsbCBxdWVyeSBtZWFucyBjcmVhdGVcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoJ3Bhc3N3b3JkJyBpbiB0aGlzLmRhdGEgfHwgJ2VtYWlsJyBpbiB0aGlzLmRhdGEpIHtcbiAgICBjb25zdCBhZGRPcHMgPSB7XG4gICAgICBfcGVyaXNoYWJsZV90b2tlbjogeyBfX29wOiAnRGVsZXRlJyB9LFxuICAgICAgX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdDogeyBfX29wOiAnRGVsZXRlJyB9LFxuICAgIH07XG4gICAgdGhpcy5kYXRhID0gT2JqZWN0LmFzc2lnbih0aGlzLmRhdGEsIGFkZE9wcyk7XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucyA9IGZ1bmN0aW9uKCkge1xuICAvLyBPbmx5IGZvciBfU2Vzc2lvbiwgYW5kIGF0IGNyZWF0aW9uIHRpbWVcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9ICdfU2Vzc2lvbicgfHwgdGhpcy5xdWVyeSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEZXN0cm95IHRoZSBzZXNzaW9ucyBpbiAnQmFja2dyb3VuZCdcbiAgY29uc3QgeyB1c2VyLCBpbnN0YWxsYXRpb25JZCwgc2Vzc2lvblRva2VuIH0gPSB0aGlzLmRhdGE7XG4gIGlmICghdXNlciB8fCAhaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCF1c2VyLm9iamVjdElkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koXG4gICAgJ19TZXNzaW9uJyxcbiAgICB7XG4gICAgICB1c2VyLFxuICAgICAgaW5zdGFsbGF0aW9uSWQsXG4gICAgICBzZXNzaW9uVG9rZW46IHsgJG5lOiBzZXNzaW9uVG9rZW4gfSxcbiAgICB9LFxuICAgIHt9LFxuICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICk7XG59O1xuXG4vLyBIYW5kbGVzIGFueSBmb2xsb3d1cCBsb2dpY1xuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVGb2xsb3d1cCA9IGZ1bmN0aW9uKCkge1xuICBpZiAoXG4gICAgdGhpcy5zdG9yYWdlICYmXG4gICAgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ10gJiZcbiAgICB0aGlzLmNvbmZpZy5yZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0XG4gICkge1xuICAgIHZhciBzZXNzaW9uUXVlcnkgPSB7XG4gICAgICB1c2VyOiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICB9LFxuICAgIH07XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddO1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmRlc3Ryb3koJ19TZXNzaW9uJywgc2Vzc2lvblF1ZXJ5KVxuICAgICAgLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddO1xuICAgIHJldHVybiB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbigpLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydzZW5kVmVyaWZpY2F0aW9uRW1haWwnXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddO1xuICAgIC8vIEZpcmUgYW5kIGZvcmdldCFcbiAgICB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZW5kVmVyaWZpY2F0aW9uRW1haWwodGhpcy5kYXRhKTtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfU2Vzc2lvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIF9TZXNzaW9uIG9iamVjdC5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlU2Vzc2lvbiA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLmNsYXNzTmFtZSAhPT0gJ19TZXNzaW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLnVzZXIgJiYgIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTixcbiAgICAgICdTZXNzaW9uIHRva2VuIHJlcXVpcmVkLidcbiAgICApO1xuICB9XG5cbiAgLy8gVE9ETzogVmVyaWZ5IHByb3BlciBlcnJvciB0byB0aHJvd1xuICBpZiAodGhpcy5kYXRhLkFDTCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAnQ2Fubm90IHNldCAnICsgJ0FDTCBvbiBhIFNlc3Npb24uJ1xuICAgICk7XG4gIH1cblxuICBpZiAodGhpcy5xdWVyeSkge1xuICAgIGlmIChcbiAgICAgIHRoaXMuZGF0YS51c2VyICYmXG4gICAgICAhdGhpcy5hdXRoLmlzTWFzdGVyICYmXG4gICAgICB0aGlzLmRhdGEudXNlci5vYmplY3RJZCAhPSB0aGlzLmF1dGgudXNlci5pZFxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmRhdGEuc2Vzc2lvblRva2VuKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICBjb25zdCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEgPSB7fTtcbiAgICBmb3IgKHZhciBrZXkgaW4gdGhpcy5kYXRhKSB7XG4gICAgICBpZiAoa2V5ID09PSAnb2JqZWN0SWQnIHx8IGtleSA9PT0gJ3VzZXInKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYWRkaXRpb25hbFNlc3Npb25EYXRhW2tleV0gPSB0aGlzLmRhdGFba2V5XTtcbiAgICB9XG5cbiAgICBjb25zdCB7IHNlc3Npb25EYXRhLCBjcmVhdGVTZXNzaW9uIH0gPSBBdXRoLmNyZWF0ZVNlc3Npb24odGhpcy5jb25maWcsIHtcbiAgICAgIHVzZXJJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICBjcmVhdGVkV2l0aDoge1xuICAgICAgICBhY3Rpb246ICdjcmVhdGUnLFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSxcbiAgICB9KTtcblxuICAgIHJldHVybiBjcmVhdGVTZXNzaW9uKCkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmICghcmVzdWx0cy5yZXNwb25zZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAgICdFcnJvciBjcmVhdGluZyBzZXNzaW9uLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHNlc3Npb25EYXRhWydvYmplY3RJZCddID0gcmVzdWx0cy5yZXNwb25zZVsnb2JqZWN0SWQnXTtcbiAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICBsb2NhdGlvbjogcmVzdWx0cy5sb2NhdGlvbixcbiAgICAgICAgcmVzcG9uc2U6IHNlc3Npb25EYXRhLFxuICAgICAgfTtcbiAgICB9KTtcbiAgfVxufTtcblxuLy8gSGFuZGxlcyB0aGUgX0luc3RhbGxhdGlvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIGluc3RhbGxhdGlvbiBvYmplY3QuXG4vLyBJZiBhbiBpbnN0YWxsYXRpb24gaXMgZm91bmQsIHRoaXMgY2FuIG11dGF0ZSB0aGlzLnF1ZXJ5IGFuZCB0dXJuIGEgY3JlYXRlXG4vLyBpbnRvIGFuIHVwZGF0ZS5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlSW5zdGFsbGF0aW9uID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMuY2xhc3NOYW1lICE9PSAnX0luc3RhbGxhdGlvbicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoXG4gICAgIXRoaXMucXVlcnkgJiZcbiAgICAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICF0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgMTM1LFxuICAgICAgJ2F0IGxlYXN0IG9uZSBJRCBmaWVsZCAoZGV2aWNlVG9rZW4sIGluc3RhbGxhdGlvbklkKSAnICtcbiAgICAgICAgJ211c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJ1xuICAgICk7XG4gIH1cblxuICAvLyBJZiB0aGUgZGV2aWNlIHRva2VuIGlzIDY0IGNoYXJhY3RlcnMgbG9uZywgd2UgYXNzdW1lIGl0IGlzIGZvciBpT1NcbiAgLy8gYW5kIGxvd2VyY2FzZSBpdC5cbiAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4ubGVuZ3RoID09IDY0KSB7XG4gICAgdGhpcy5kYXRhLmRldmljZVRva2VuID0gdGhpcy5kYXRhLmRldmljZVRva2VuLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBXZSBsb3dlcmNhc2UgdGhlIGluc3RhbGxhdGlvbklkIGlmIHByZXNlbnRcbiAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCA9IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZC50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgbGV0IGluc3RhbGxhdGlvbklkID0gdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkO1xuXG4gIC8vIElmIGRhdGEuaW5zdGFsbGF0aW9uSWQgaXMgbm90IHNldCBhbmQgd2UncmUgbm90IG1hc3Rlciwgd2UgY2FuIGxvb2t1cCBpbiBhdXRoXG4gIGlmICghaW5zdGFsbGF0aW9uSWQgJiYgIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIGluc3RhbGxhdGlvbklkID0gdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG5cbiAgaWYgKGluc3RhbGxhdGlvbklkKSB7XG4gICAgaW5zdGFsbGF0aW9uSWQgPSBpbnN0YWxsYXRpb25JZC50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgLy8gVXBkYXRpbmcgX0luc3RhbGxhdGlvbiBidXQgbm90IHVwZGF0aW5nIGFueXRoaW5nIGNyaXRpY2FsXG4gIGlmIChcbiAgICB0aGlzLnF1ZXJ5ICYmXG4gICAgIXRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICFpbnN0YWxsYXRpb25JZCAmJlxuICAgICF0aGlzLmRhdGEuZGV2aWNlVHlwZVxuICApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4gIHZhciBpZE1hdGNoOyAvLyBXaWxsIGJlIGEgbWF0Y2ggb24gZWl0aGVyIG9iamVjdElkIG9yIGluc3RhbGxhdGlvbklkXG4gIHZhciBvYmplY3RJZE1hdGNoO1xuICB2YXIgaW5zdGFsbGF0aW9uSWRNYXRjaDtcbiAgdmFyIGRldmljZVRva2VuTWF0Y2hlcyA9IFtdO1xuXG4gIC8vIEluc3RlYWQgb2YgaXNzdWluZyAzIHJlYWRzLCBsZXQncyBkbyBpdCB3aXRoIG9uZSBPUi5cbiAgY29uc3Qgb3JRdWVyaWVzID0gW107XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBvYmplY3RJZDogdGhpcy5xdWVyeS5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBpbnN0YWxsYXRpb25JZDogaW5zdGFsbGF0aW9uSWQsXG4gICAgfSk7XG4gIH1cbiAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgIG9yUXVlcmllcy5wdXNoKHsgZGV2aWNlVG9rZW46IHRoaXMuZGF0YS5kZXZpY2VUb2tlbiB9KTtcbiAgfVxuXG4gIGlmIChvclF1ZXJpZXMubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBwcm9taXNlID0gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAnX0luc3RhbGxhdGlvbicsXG4gICAgICAgIHtcbiAgICAgICAgICAkb3I6IG9yUXVlcmllcyxcbiAgICAgICAgfSxcbiAgICAgICAge31cbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMuZm9yRWFjaChyZXN1bHQgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5xdWVyeSAmJlxuICAgICAgICAgIHRoaXMucXVlcnkub2JqZWN0SWQgJiZcbiAgICAgICAgICByZXN1bHQub2JqZWN0SWQgPT0gdGhpcy5xdWVyeS5vYmplY3RJZFxuICAgICAgICApIHtcbiAgICAgICAgICBvYmplY3RJZE1hdGNoID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXN1bHQuaW5zdGFsbGF0aW9uSWQgPT0gaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICBpbnN0YWxsYXRpb25JZE1hdGNoID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXN1bHQuZGV2aWNlVG9rZW4gPT0gdGhpcy5kYXRhLmRldmljZVRva2VuKSB7XG4gICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaGVzLnB1c2gocmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIC8vIFNhbml0eSBjaGVja3Mgd2hlbiBydW5uaW5nIGEgcXVlcnlcbiAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgaWYgKCFvYmplY3RJZE1hdGNoKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kIGZvciB1cGRhdGUuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgIG9iamVjdElkTWF0Y2guaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgIT09IG9iamVjdElkTWF0Y2guaW5zdGFsbGF0aW9uSWRcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgMTM2LFxuICAgICAgICAgICAgJ2luc3RhbGxhdGlvbklkIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgKyAnb3BlcmF0aW9uJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgIG9iamVjdElkTWF0Y2guZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gIT09IG9iamVjdElkTWF0Y2guZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICAhdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgIW9iamVjdElkTWF0Y2guaW5zdGFsbGF0aW9uSWRcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgMTM2LFxuICAgICAgICAgICAgJ2RldmljZVRva2VuIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgKyAnb3BlcmF0aW9uJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAhPT0gb2JqZWN0SWRNYXRjaC5kZXZpY2VUeXBlXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIDEzNixcbiAgICAgICAgICAgICdkZXZpY2VUeXBlIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgKyAnb3BlcmF0aW9uJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCAmJiBvYmplY3RJZE1hdGNoKSB7XG4gICAgICAgIGlkTWF0Y2ggPSBvYmplY3RJZE1hdGNoO1xuICAgICAgfVxuXG4gICAgICBpZiAoaW5zdGFsbGF0aW9uSWQgJiYgaW5zdGFsbGF0aW9uSWRNYXRjaCkge1xuICAgICAgICBpZE1hdGNoID0gaW5zdGFsbGF0aW9uSWRNYXRjaDtcbiAgICAgIH1cbiAgICAgIC8vIG5lZWQgdG8gc3BlY2lmeSBkZXZpY2VUeXBlIG9ubHkgaWYgaXQncyBuZXdcbiAgICAgIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmRldmljZVR5cGUgJiYgIWlkTWF0Y2gpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIDEzNSxcbiAgICAgICAgICAnZGV2aWNlVHlwZSBtdXN0IGJlIHNwZWNpZmllZCBpbiB0aGlzIG9wZXJhdGlvbidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIGlmICghaWRNYXRjaCkge1xuICAgICAgICBpZiAoIWRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGgpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmXG4gICAgICAgICAgKCFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ10gfHwgIWluc3RhbGxhdGlvbklkKVxuICAgICAgICApIHtcbiAgICAgICAgICAvLyBTaW5nbGUgbWF0Y2ggb24gZGV2aWNlIHRva2VuIGJ1dCBub25lIG9uIGluc3RhbGxhdGlvbklkLCBhbmQgZWl0aGVyXG4gICAgICAgICAgLy8gdGhlIHBhc3NlZCBvYmplY3Qgb3IgdGhlIG1hdGNoIGlzIG1pc3NpbmcgYW4gaW5zdGFsbGF0aW9uSWQsIHNvIHdlXG4gICAgICAgICAgLy8gY2FuIGp1c3QgcmV0dXJuIHRoZSBtYXRjaC5cbiAgICAgICAgICByZXR1cm4gZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydvYmplY3RJZCddO1xuICAgICAgICB9IGVsc2UgaWYgKCF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAxMzIsXG4gICAgICAgICAgICAnTXVzdCBzcGVjaWZ5IGluc3RhbGxhdGlvbklkIHdoZW4gZGV2aWNlVG9rZW4gJyArXG4gICAgICAgICAgICAgICdtYXRjaGVzIG11bHRpcGxlIEluc3RhbGxhdGlvbiBvYmplY3RzJ1xuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gTXVsdGlwbGUgZGV2aWNlIHRva2VuIG1hdGNoZXMgYW5kIHdlIHNwZWNpZmllZCBhbiBpbnN0YWxsYXRpb24gSUQsXG4gICAgICAgICAgLy8gb3IgYSBzaW5nbGUgbWF0Y2ggd2hlcmUgYm90aCB0aGUgcGFzc2VkIGFuZCBtYXRjaGluZyBvYmplY3RzIGhhdmVcbiAgICAgICAgICAvLyBhbiBpbnN0YWxsYXRpb24gSUQuIFRyeSBjbGVhbmluZyBvdXQgb2xkIGluc3RhbGxhdGlvbnMgdGhhdCBtYXRjaFxuICAgICAgICAgIC8vIHRoZSBkZXZpY2VUb2tlbiwgYW5kIHJldHVybiBuaWwgdG8gc2lnbmFsIHRoYXQgYSBuZXcgb2JqZWN0IHNob3VsZFxuICAgICAgICAgIC8vIGJlIGNyZWF0ZWQuXG4gICAgICAgICAgdmFyIGRlbFF1ZXJ5ID0ge1xuICAgICAgICAgICAgZGV2aWNlVG9rZW46IHRoaXMuZGF0YS5kZXZpY2VUb2tlbixcbiAgICAgICAgICAgIGluc3RhbGxhdGlvbklkOiB7XG4gICAgICAgICAgICAgICRuZTogaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH07XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyKSB7XG4gICAgICAgICAgICBkZWxRdWVyeVsnYXBwSWRlbnRpZmllciddID0gdGhpcy5kYXRhLmFwcElkZW50aWZpZXI7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koJ19JbnN0YWxsYXRpb24nLCBkZWxRdWVyeSkuY2F0Y2goZXJyID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkLlxuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyByZXRocm93IHRoZSBlcnJvclxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGggPT0gMSAmJlxuICAgICAgICAgICFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ11cbiAgICAgICAgKSB7XG4gICAgICAgICAgLy8gRXhhY3RseSBvbmUgZGV2aWNlIHRva2VuIG1hdGNoIGFuZCBpdCBkb2Vzbid0IGhhdmUgYW4gaW5zdGFsbGF0aW9uXG4gICAgICAgICAgLy8gSUQuIFRoaXMgaXMgdGhlIG9uZSBjYXNlIHdoZXJlIHdlIHdhbnQgdG8gbWVyZ2Ugd2l0aCB0aGUgZXhpc3RpbmdcbiAgICAgICAgICAvLyBvYmplY3QuXG4gICAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7IG9iamVjdElkOiBpZE1hdGNoLm9iamVjdElkIH07XG4gICAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgICAgICAuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydvYmplY3RJZCddO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgICBpZiAoZXJyLmNvZGUgPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIC8vIHJldGhyb3cgdGhlIGVycm9yXG4gICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgICAgaWRNYXRjaC5kZXZpY2VUb2tlbiAhPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW5cbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIC8vIFdlJ3JlIHNldHRpbmcgdGhlIGRldmljZSB0b2tlbiBvbiBhbiBleGlzdGluZyBpbnN0YWxsYXRpb24sIHNvXG4gICAgICAgICAgICAvLyB3ZSBzaG91bGQgdHJ5IGNsZWFuaW5nIG91dCBvbGQgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoIHRoaXNcbiAgICAgICAgICAgIC8vIGRldmljZSB0b2tlbi5cbiAgICAgICAgICAgIGNvbnN0IGRlbFF1ZXJ5ID0ge1xuICAgICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIC8vIFdlIGhhdmUgYSB1bmlxdWUgaW5zdGFsbCBJZCwgdXNlIHRoYXQgdG8gcHJlc2VydmVcbiAgICAgICAgICAgIC8vIHRoZSBpbnRlcmVzdGluZyBpbnN0YWxsYXRpb25cbiAgICAgICAgICAgIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ2luc3RhbGxhdGlvbklkJ10gPSB7XG4gICAgICAgICAgICAgICAgJG5lOiB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCAmJlxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkID09IHRoaXMuZGF0YS5vYmplY3RJZFxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIC8vIHdlIHBhc3NlZCBhbiBvYmplY3RJZCwgcHJlc2VydmUgdGhhdCBpbnN0YWxhdGlvblxuICAgICAgICAgICAgICBkZWxRdWVyeVsnb2JqZWN0SWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IGlkTWF0Y2gub2JqZWN0SWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBXaGF0IHRvIGRvIGhlcmU/IGNhbid0IHJlYWxseSBjbGVhbiB1cCBldmVyeXRoaW5nLi4uXG4gICAgICAgICAgICAgIHJldHVybiBpZE1hdGNoLm9iamVjdElkO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyKSB7XG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgICAgICAgIC5kZXN0cm95KCdfSW5zdGFsbGF0aW9uJywgZGVsUXVlcnkpXG4gICAgICAgICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgICAgICAvLyBubyBkZWxldGlvbnMgd2VyZSBtYWRlLiBDYW4gYmUgaWdub3JlZC5cbiAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgLy8gcmV0aHJvdyB0aGUgZXJyb3JcbiAgICAgICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBJbiBub24tbWVyZ2Ugc2NlbmFyaW9zLCBqdXN0IHJldHVybiB0aGUgaW5zdGFsbGF0aW9uIG1hdGNoIGlkXG4gICAgICAgICAgcmV0dXJuIGlkTWF0Y2gub2JqZWN0SWQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KVxuICAgIC50aGVuKG9iaklkID0+IHtcbiAgICAgIGlmIChvYmpJZCkge1xuICAgICAgICB0aGlzLnF1ZXJ5ID0geyBvYmplY3RJZDogb2JqSWQgfTtcbiAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG4gICAgICB9XG4gICAgICAvLyBUT0RPOiBWYWxpZGF0ZSBvcHMgKGFkZC9yZW1vdmUgb24gY2hhbm5lbHMsICRpbmMgb24gYmFkZ2UsIGV0Yy4pXG4gICAgfSk7XG4gIHJldHVybiBwcm9taXNlO1xufTtcblxuLy8gSWYgd2Ugc2hvcnQtY2lyY3V0ZWQgdGhlIG9iamVjdCByZXNwb25zZSAtIHRoZW4gd2UgbmVlZCB0byBtYWtlIHN1cmUgd2UgZXhwYW5kIGFsbCB0aGUgZmlsZXMsXG4vLyBzaW5jZSB0aGlzIG1pZ2h0IG5vdCBoYXZlIGEgcXVlcnksIG1lYW5pbmcgaXQgd29uJ3QgcmV0dXJuIHRoZSBmdWxsIHJlc3VsdCBiYWNrLlxuLy8gVE9ETzogKG5sdXRzZW5rbykgVGhpcyBzaG91bGQgZGllIHdoZW4gd2UgbW92ZSB0byBwZXItY2xhc3MgYmFzZWQgY29udHJvbGxlcnMgb24gX1Nlc3Npb24vX1VzZXJcblJlc3RXcml0ZS5wcm90b3R5cGUuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMgPSBmdW5jdGlvbigpIHtcbiAgLy8gQ2hlY2sgd2hldGhlciB3ZSBoYXZlIGEgc2hvcnQtY2lyY3VpdGVkIHJlc3BvbnNlIC0gb25seSB0aGVuIHJ1biBleHBhbnNpb24uXG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICB0aGlzLmNvbmZpZy5maWxlc0NvbnRyb2xsZXIuZXhwYW5kRmlsZXNJbk9iamVjdChcbiAgICAgIHRoaXMuY29uZmlnLFxuICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZVxuICAgICk7XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuRGF0YWJhc2VPcGVyYXRpb24gPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfUm9sZScpIHtcbiAgICB0aGlzLmNvbmZpZy5jYWNoZUNvbnRyb2xsZXIucm9sZS5jbGVhcigpO1xuICB9XG5cbiAgaWYgKFxuICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgdGhpcy5xdWVyeSAmJlxuICAgIHRoaXMuYXV0aC5pc1VuYXV0aGVudGljYXRlZCgpXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLlNFU1NJT05fTUlTU0lORyxcbiAgICAgIGBDYW5ub3QgbW9kaWZ5IHVzZXIgJHt0aGlzLnF1ZXJ5Lm9iamVjdElkfS5gXG4gICAgKTtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Qcm9kdWN0JyAmJiB0aGlzLmRhdGEuZG93bmxvYWQpIHtcbiAgICB0aGlzLmRhdGEuZG93bmxvYWROYW1lID0gdGhpcy5kYXRhLmRvd25sb2FkLm5hbWU7XG4gIH1cblxuICAvLyBUT0RPOiBBZGQgYmV0dGVyIGRldGVjdGlvbiBmb3IgQUNMLCBlbnN1cmluZyBhIHVzZXIgY2FuJ3QgYmUgbG9ja2VkIGZyb21cbiAgLy8gICAgICAgdGhlaXIgb3duIHVzZXIgcmVjb3JkLlxuICBpZiAodGhpcy5kYXRhLkFDTCAmJiB0aGlzLmRhdGEuQUNMWycqdW5yZXNvbHZlZCddKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfQUNMLCAnSW52YWxpZCBBQ0wuJyk7XG4gIH1cblxuICBpZiAodGhpcy5xdWVyeSkge1xuICAgIC8vIEZvcmNlIHRoZSB1c2VyIHRvIG5vdCBsb2Nrb3V0XG4gICAgLy8gTWF0Y2hlZCB3aXRoIHBhcnNlLmNvbVxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuQUNMICYmXG4gICAgICB0aGlzLmF1dGguaXNNYXN0ZXIgIT09IHRydWVcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5BQ0xbdGhpcy5xdWVyeS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgfVxuICAgIC8vIHVwZGF0ZSBwYXNzd29yZCB0aW1lc3RhbXAgaWYgdXNlciBwYXNzd29yZCBpcyBiZWluZyBjaGFuZ2VkXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2VcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSk7XG4gICAgfVxuICAgIC8vIElnbm9yZSBjcmVhdGVkQXQgd2hlbiB1cGRhdGVcbiAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcblxuICAgIGxldCBkZWZlciA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIC8vIGlmIHBhc3N3b3JkIGhpc3RvcnkgaXMgZW5hYmxlZCB0aGVuIHNhdmUgdGhlIGN1cnJlbnQgcGFzc3dvcmQgdG8gaGlzdG9yeVxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeVxuICAgICkge1xuICAgICAgZGVmZXIgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAuZmluZChcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICAgIHsga2V5czogWydfcGFzc3dvcmRfaGlzdG9yeScsICdfaGFzaGVkX3Bhc3N3b3JkJ10gfVxuICAgICAgICApXG4gICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICAgIGxldCBvbGRQYXNzd29yZHMgPSBbXTtcbiAgICAgICAgICBpZiAodXNlci5fcGFzc3dvcmRfaGlzdG9yeSkge1xuICAgICAgICAgICAgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgICAgICB1c2VyLl9wYXNzd29yZF9oaXN0b3J5LFxuICAgICAgICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnlcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vbi0xIHBhc3N3b3JkcyBnbyBpbnRvIGhpc3RvcnkgaW5jbHVkaW5nIGxhc3QgcGFzc3dvcmRcbiAgICAgICAgICB3aGlsZSAoXG4gICAgICAgICAgICBvbGRQYXNzd29yZHMubGVuZ3RoID5cbiAgICAgICAgICAgIE1hdGgubWF4KDAsIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDIpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICBvbGRQYXNzd29yZHMuc2hpZnQoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9oaXN0b3J5ID0gb2xkUGFzc3dvcmRzO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gZGVmZXIudGhlbigoKSA9PiB7XG4gICAgICAvLyBSdW4gYW4gdXBkYXRlXG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgLnVwZGF0ZShcbiAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICB0aGlzLnF1ZXJ5LFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICAgICAgKVxuICAgICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgICAgcmVzcG9uc2UudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgICAgdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShyZXNwb25zZSwgdGhpcy5kYXRhKTtcbiAgICAgICAgICB0aGlzLnJlc3BvbnNlID0geyByZXNwb25zZSB9O1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICAvLyBTZXQgdGhlIGRlZmF1bHQgQUNMIGFuZCBwYXNzd29yZCB0aW1lc3RhbXAgZm9yIHRoZSBuZXcgX1VzZXJcbiAgICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAgIHZhciBBQ0wgPSB0aGlzLmRhdGEuQUNMO1xuICAgICAgLy8gZGVmYXVsdCBwdWJsaWMgci93IEFDTFxuICAgICAgaWYgKCFBQ0wpIHtcbiAgICAgICAgQUNMID0ge307XG4gICAgICAgIEFDTFsnKiddID0geyByZWFkOiB0cnVlLCB3cml0ZTogZmFsc2UgfTtcbiAgICAgIH1cbiAgICAgIC8vIG1ha2Ugc3VyZSB0aGUgdXNlciBpcyBub3QgbG9ja2VkIGRvd25cbiAgICAgIEFDTFt0aGlzLmRhdGEub2JqZWN0SWRdID0geyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9O1xuICAgICAgdGhpcy5kYXRhLkFDTCA9IEFDTDtcbiAgICAgIC8vIHBhc3N3b3JkIHRpbWVzdGFtcCB0byBiZSB1c2VkIHdoZW4gcGFzc3dvcmQgZXhwaXJ5IHBvbGljeSBpcyBlbmZvcmNlZFxuICAgICAgaWYgKFxuICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZVxuICAgICAgKSB7XG4gICAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUnVuIGEgY3JlYXRlXG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuY3JlYXRlKFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgIGZhbHNlLFxuICAgICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgICAgKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8XG4gICAgICAgICAgZXJyb3IuY29kZSAhPT0gUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUXVpY2sgY2hlY2ssIGlmIHdlIHdlcmUgYWJsZSB0byBpbmZlciB0aGUgZHVwbGljYXRlZCBmaWVsZCBuYW1lXG4gICAgICAgIGlmIChcbiAgICAgICAgICBlcnJvciAmJlxuICAgICAgICAgIGVycm9yLnVzZXJJbmZvICYmXG4gICAgICAgICAgZXJyb3IudXNlckluZm8uZHVwbGljYXRlZF9maWVsZCA9PT0gJ3VzZXJuYW1lJ1xuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKFxuICAgICAgICAgIGVycm9yICYmXG4gICAgICAgICAgZXJyb3IudXNlckluZm8gJiZcbiAgICAgICAgICBlcnJvci51c2VySW5mby5kdXBsaWNhdGVkX2ZpZWxkID09PSAnZW1haWwnXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIElmIHRoaXMgd2FzIGEgZmFpbGVkIHVzZXIgY3JlYXRpb24gZHVlIHRvIHVzZXJuYW1lIG9yIGVtYWlsIGFscmVhZHkgdGFrZW4sIHdlIG5lZWQgdG9cbiAgICAgICAgLy8gY2hlY2sgd2hldGhlciBpdCB3YXMgdXNlcm5hbWUgb3IgZW1haWwgYW5kIHJldHVybiB0aGUgYXBwcm9wcmlhdGUgZXJyb3IuXG4gICAgICAgIC8vIEZhbGxiYWNrIHRvIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICAgICAgLy8gVE9ETzogU2VlIGlmIHdlIGNhbiBsYXRlciBkbyB0aGlzIHdpdGhvdXQgYWRkaXRpb25hbCBxdWVyaWVzIGJ5IHVzaW5nIG5hbWVkIGluZGV4ZXMuXG4gICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAgIC5maW5kKFxuICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHVzZXJuYW1lOiB0aGlzLmRhdGEudXNlcm5hbWUsXG4gICAgICAgICAgICAgIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgeyBsaW1pdDogMSB9XG4gICAgICAgICAgKVxuICAgICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfVEFLRU4sXG4gICAgICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgICAgICB7IGVtYWlsOiB0aGlzLmRhdGEuZW1haWwsIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0gfSxcbiAgICAgICAgICAgICAgeyBsaW1pdDogMSB9XG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgICAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgICByZXNwb25zZS5vYmplY3RJZCA9IHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgcmVzcG9uc2UuY3JlYXRlZEF0ID0gdGhpcy5kYXRhLmNyZWF0ZWRBdDtcblxuICAgICAgICBpZiAodGhpcy5yZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSkge1xuICAgICAgICAgIHJlc3BvbnNlLnVzZXJuYW1lID0gdGhpcy5kYXRhLnVzZXJuYW1lO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEocmVzcG9uc2UsIHRoaXMuZGF0YSk7XG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgICAgc3RhdHVzOiAyMDEsXG4gICAgICAgICAgcmVzcG9uc2UsXG4gICAgICAgICAgbG9jYXRpb246IHRoaXMubG9jYXRpb24oKSxcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICB9XG59O1xuXG4vLyBSZXR1cm5zIG5vdGhpbmcgLSBkb2Vzbid0IHdhaXQgZm9yIHRoZSB0cmlnZ2VyLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5BZnRlclNhdmVUcmlnZ2VyID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5yZXNwb25zZSB8fCAhdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyU2F2ZScgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJTYXZlSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLFxuICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgKTtcbiAgY29uc3QgaGFzTGl2ZVF1ZXJ5ID0gdGhpcy5jb25maWcubGl2ZVF1ZXJ5Q29udHJvbGxlci5oYXNMaXZlUXVlcnkoXG4gICAgdGhpcy5jbGFzc05hbWVcbiAgKTtcbiAgaWYgKCFoYXNBZnRlclNhdmVIb29rICYmICFoYXNMaXZlUXVlcnkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB2YXIgZXh0cmFEYXRhID0geyBjbGFzc05hbWU6IHRoaXMuY2xhc3NOYW1lIH07XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBleHRyYURhdGEub2JqZWN0SWQgPSB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICB9XG5cbiAgLy8gQnVpbGQgdGhlIG9yaWdpbmFsIG9iamVjdCwgd2Ugb25seSBkbyB0aGlzIGZvciBhIHVwZGF0ZSB3cml0ZS5cbiAgbGV0IG9yaWdpbmFsT2JqZWN0O1xuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgb3JpZ2luYWxPYmplY3QgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdGhpcy5vcmlnaW5hbERhdGEpO1xuICB9XG5cbiAgLy8gQnVpbGQgdGhlIGluZmxhdGVkIG9iamVjdCwgZGlmZmVyZW50IGZyb20gYmVmb3JlU2F2ZSwgb3JpZ2luYWxEYXRhIGlzIG5vdCBlbXB0eVxuICAvLyBzaW5jZSBkZXZlbG9wZXJzIGNhbiBjaGFuZ2UgZGF0YSBpbiB0aGUgYmVmb3JlU2F2ZS5cbiAgY29uc3QgdXBkYXRlZE9iamVjdCA9IHRoaXMuYnVpbGRVcGRhdGVkT2JqZWN0KGV4dHJhRGF0YSk7XG4gIHVwZGF0ZWRPYmplY3QuX2hhbmRsZVNhdmVSZXNwb25zZShcbiAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLFxuICAgIHRoaXMucmVzcG9uc2Uuc3RhdHVzIHx8IDIwMFxuICApO1xuXG4gIHRoaXMuY29uZmlnLmRhdGFiYXNlLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgIC8vIE5vdGlmaXkgTGl2ZVF1ZXJ5U2VydmVyIGlmIHBvc3NpYmxlXG4gICAgY29uc3QgcGVybXMgPSBzY2hlbWFDb250cm9sbGVyLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhcbiAgICAgIHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lXG4gICAgKTtcbiAgICB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLm9uQWZ0ZXJTYXZlKFxuICAgICAgdXBkYXRlZE9iamVjdC5jbGFzc05hbWUsXG4gICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgb3JpZ2luYWxPYmplY3QsXG4gICAgICBwZXJtc1xuICAgICk7XG4gIH0pO1xuXG4gIC8vIFJ1biBhZnRlclNhdmUgdHJpZ2dlclxuICByZXR1cm4gdHJpZ2dlcnNcbiAgICAubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLFxuICAgICAgdGhpcy5hdXRoLFxuICAgICAgdXBkYXRlZE9iamVjdCxcbiAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLmNvbnRleHRcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgIGlmIChyZXN1bHQgJiYgdHlwZW9mIHJlc3VsdCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZSA9IHJlc3VsdDtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaChmdW5jdGlvbihlcnIpIHtcbiAgICAgIGxvZ2dlci53YXJuKCdhZnRlclNhdmUgY2F1Z2h0IGFuIGVycm9yJywgZXJyKTtcbiAgICB9KTtcbn07XG5cbi8vIEEgaGVscGVyIHRvIGZpZ3VyZSBvdXQgd2hhdCBsb2NhdGlvbiB0aGlzIG9wZXJhdGlvbiBoYXBwZW5zIGF0LlxuUmVzdFdyaXRlLnByb3RvdHlwZS5sb2NhdGlvbiA9IGZ1bmN0aW9uKCkge1xuICB2YXIgbWlkZGxlID1cbiAgICB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyA/ICcvdXNlcnMvJyA6ICcvY2xhc3Nlcy8nICsgdGhpcy5jbGFzc05hbWUgKyAnLyc7XG4gIHJldHVybiB0aGlzLmNvbmZpZy5tb3VudCArIG1pZGRsZSArIHRoaXMuZGF0YS5vYmplY3RJZDtcbn07XG5cbi8vIEEgaGVscGVyIHRvIGdldCB0aGUgb2JqZWN0IGlkIGZvciB0aGlzIG9wZXJhdGlvbi5cbi8vIEJlY2F1c2UgaXQgY291bGQgYmUgZWl0aGVyIG9uIHRoZSBxdWVyeSBvciBvbiB0aGUgZGF0YVxuUmVzdFdyaXRlLnByb3RvdHlwZS5vYmplY3RJZCA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5kYXRhLm9iamVjdElkIHx8IHRoaXMucXVlcnkub2JqZWN0SWQ7XG59O1xuXG4vLyBSZXR1cm5zIGEgY29weSBvZiB0aGUgZGF0YSBhbmQgZGVsZXRlIGJhZCBrZXlzIChfYXV0aF9kYXRhLCBfaGFzaGVkX3Bhc3N3b3JkLi4uKVxuUmVzdFdyaXRlLnByb3RvdHlwZS5zYW5pdGl6ZWREYXRhID0gZnVuY3Rpb24oKSB7XG4gIGNvbnN0IGRhdGEgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLnJlZHVjZSgoZGF0YSwga2V5KSA9PiB7XG4gICAgLy8gUmVnZXhwIGNvbWVzIGZyb20gUGFyc2UuT2JqZWN0LnByb3RvdHlwZS52YWxpZGF0ZVxuICAgIGlmICghL15bQS1aYS16XVswLTlBLVphLXpfXSokLy50ZXN0KGtleSkpIHtcbiAgICAgIGRlbGV0ZSBkYXRhW2tleV07XG4gICAgfVxuICAgIHJldHVybiBkYXRhO1xuICB9LCBkZWVwY29weSh0aGlzLmRhdGEpKTtcbiAgcmV0dXJuIFBhcnNlLl9kZWNvZGUodW5kZWZpbmVkLCBkYXRhKTtcbn07XG5cbi8vIFJldHVybnMgYW4gdXBkYXRlZCBjb3B5IG9mIHRoZSBvYmplY3RcblJlc3RXcml0ZS5wcm90b3R5cGUuYnVpbGRVcGRhdGVkT2JqZWN0ID0gZnVuY3Rpb24oZXh0cmFEYXRhKSB7XG4gIGNvbnN0IHVwZGF0ZWRPYmplY3QgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdGhpcy5vcmlnaW5hbERhdGEpO1xuICBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLnJlZHVjZShmdW5jdGlvbihkYXRhLCBrZXkpIHtcbiAgICBpZiAoa2V5LmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgIC8vIHN1YmRvY3VtZW50IGtleSB3aXRoIGRvdCBub3RhdGlvbiAoJ3gueSc6diA9PiAneCc6eyd5Jzp2fSlcbiAgICAgIGNvbnN0IHNwbGl0dGVkS2V5ID0ga2V5LnNwbGl0KCcuJyk7XG4gICAgICBjb25zdCBwYXJlbnRQcm9wID0gc3BsaXR0ZWRLZXlbMF07XG4gICAgICBsZXQgcGFyZW50VmFsID0gdXBkYXRlZE9iamVjdC5nZXQocGFyZW50UHJvcCk7XG4gICAgICBpZiAodHlwZW9mIHBhcmVudFZhbCAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgcGFyZW50VmFsID0ge307XG4gICAgICB9XG4gICAgICBwYXJlbnRWYWxbc3BsaXR0ZWRLZXlbMV1dID0gZGF0YVtrZXldO1xuICAgICAgdXBkYXRlZE9iamVjdC5zZXQocGFyZW50UHJvcCwgcGFyZW50VmFsKTtcbiAgICAgIGRlbGV0ZSBkYXRhW2tleV07XG4gICAgfVxuICAgIHJldHVybiBkYXRhO1xuICB9LCBkZWVwY29weSh0aGlzLmRhdGEpKTtcblxuICB1cGRhdGVkT2JqZWN0LnNldCh0aGlzLnNhbml0aXplZERhdGEoKSk7XG4gIHJldHVybiB1cGRhdGVkT2JqZWN0O1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jbGVhblVzZXJBdXRoRGF0YSA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlICYmIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgY29uc3QgdXNlciA9IHRoaXMucmVzcG9uc2UucmVzcG9uc2U7XG4gICAgaWYgKHVzZXIuYXV0aERhdGEpIHtcbiAgICAgIE9iamVjdC5rZXlzKHVzZXIuYXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICBpZiAodXNlci5hdXRoRGF0YVtwcm92aWRlcl0gPT09IG51bGwpIHtcbiAgICAgICAgICBkZWxldGUgdXNlci5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgaWYgKE9iamVjdC5rZXlzKHVzZXIuYXV0aERhdGEpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSA9IGZ1bmN0aW9uKHJlc3BvbnNlLCBkYXRhKSB7XG4gIGlmIChfLmlzRW1wdHkodGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9XG4gIGNvbnN0IGNsaWVudFN1cHBvcnRzRGVsZXRlID0gQ2xpZW50U0RLLnN1cHBvcnRzRm9yd2FyZERlbGV0ZSh0aGlzLmNsaWVudFNESyk7XG4gIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICBjb25zdCBkYXRhVmFsdWUgPSBkYXRhW2ZpZWxkTmFtZV07XG5cbiAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChyZXNwb25zZSwgZmllbGROYW1lKSkge1xuICAgICAgcmVzcG9uc2VbZmllbGROYW1lXSA9IGRhdGFWYWx1ZTtcbiAgICB9XG5cbiAgICAvLyBTdHJpcHMgb3BlcmF0aW9ucyBmcm9tIHJlc3BvbnNlc1xuICAgIGlmIChyZXNwb25zZVtmaWVsZE5hbWVdICYmIHJlc3BvbnNlW2ZpZWxkTmFtZV0uX19vcCkge1xuICAgICAgZGVsZXRlIHJlc3BvbnNlW2ZpZWxkTmFtZV07XG4gICAgICBpZiAoY2xpZW50U3VwcG9ydHNEZWxldGUgJiYgZGF0YVZhbHVlLl9fb3AgPT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgcmVzcG9uc2VbZmllbGROYW1lXSA9IGRhdGFWYWx1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gcmVzcG9uc2U7XG59O1xuXG5leHBvcnQgZGVmYXVsdCBSZXN0V3JpdGU7XG5tb2R1bGUuZXhwb3J0cyA9IFJlc3RXcml0ZTtcbiJdfQ==
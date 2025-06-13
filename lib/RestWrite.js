"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _RestQuery = _interopRequireDefault(require("./RestQuery"));
var _lodash = _interopRequireDefault(require("lodash"));
var _logger = _interopRequireDefault(require("./logger"));
var _SchemaController = require("./Controllers/SchemaController");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// A RestWrite encapsulates everything we need to run an operation
// that writes to the database.
// This could be either a "create" or an "update".

var SchemaController = require('./Controllers/SchemaController');
var deepcopy = require('deepcopy');
const Auth = require('./Auth');
const Utils = require('./Utils');
var cryptoUtils = require('./cryptoUtils');
var passwordCrypto = require('./password');
var Parse = require('parse/node');
var triggers = require('./triggers');
var ClientSDK = require('./ClientSDK');
const util = require('util');
// query and data are both provided in REST API format. So data
// types are encoded by plain old objects.
// If query is null, this is a "create" and the data in data should be
// created.
// Otherwise this is an "update" - the object matching the query
// should get updated with data.
// RestWrite will handle objectId, createdAt, and updatedAt for
// everything. It also knows to use triggers and special modifications
// for the _User class.
function RestWrite(config, auth, className, query, data, originalData, clientSDK, context, action) {
  if (auth.isReadOnly) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Cannot perform a write operation when using readOnlyMasterKey');
  }
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.clientSDK = clientSDK;
  this.storage = {};
  this.runOptions = {};
  this.context = context || {};
  if (action) {
    this.runOptions.action = action;
  }
  if (!query) {
    if (this.config.allowCustomObjectId) {
      if (Object.prototype.hasOwnProperty.call(data, 'objectId') && !data.objectId) {
        throw new Parse.Error(Parse.Error.MISSING_OBJECT_ID, 'objectId must not be empty, null or undefined');
      }
    } else {
      if (data.objectId) {
        throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'objectId is an invalid field name.');
      }
      if (data.id) {
        throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'id is an invalid field name.');
      }
    }
  }

  // When the operation is complete, this.response may have several
  // fields.
  // response: the actual data to be returned
  // status: the http status code. if not present, treated like a 200
  // location: the location header. if not present, no location header
  this.response = null;

  // Processing this operation may mutate our data, so we operate on a
  // copy
  this.query = deepcopy(query);
  this.data = deepcopy(data);
  // We never change originalData, so we do not need a deep copy
  this.originalData = originalData;

  // The timestamp we'll use for this whole operation
  this.updatedAt = Parse._encode(new Date()).iso;

  // Shared SchemaController to be reused to reduce the number of loadSchema() calls per request
  // Once set the schemaData should be immutable
  this.validSchemaController = null;
  this.pendingOps = {
    operations: null,
    identifier: null
  };
}

// A convenient method to perform all the steps of processing the
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
    return this.checkRestrictedFields();
  }).then(() => {
    return this.runBeforeSaveTrigger();
  }).then(() => {
    return this.ensureUniqueAuthDataId();
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
    // Append the authDataResponse if exists
    if (this.authDataResponse) {
      if (this.response && this.response.response) {
        this.response.response.authDataResponse = this.authDataResponse;
      }
    }
    if (this.storage.rejectSignup && this.config.preventSignupWithUnverifiedEmail) {
      throw new Parse.Error(Parse.Error.EMAIL_NOT_FOUND, 'User email is not verified.');
    }
    return this.response;
  });
};

// Uses the Auth object to get the list of roles, adds the user id
RestWrite.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
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
};

// Validates this operation against the allowClientClassCreation config.
RestWrite.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && !this.auth.isMaintenance && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className);
      }
    });
  } else {
    return Promise.resolve();
  }
};

// Validates this operation against the schema.
RestWrite.prototype.validateSchema = function () {
  return this.config.database.validateObject(this.className, this.data, this.query, this.runOptions, this.auth.isMaintenance);
};

// Runs any beforeSave triggers against this operation.
// Any change leads to our data being mutated.
RestWrite.prototype.runBeforeSaveTrigger = function () {
  if (this.response || this.runOptions.many) {
    return;
  }

  // Avoid doing any setup for triggers if there is no 'beforeSave' trigger for this class.
  if (!triggers.triggerExists(this.className, triggers.Types.beforeSave, this.config.applicationId)) {
    return Promise.resolve();
  }
  const {
    originalObject,
    updatedObject
  } = this.buildParseObjects();
  const identifier = updatedObject._getStateIdentifier();
  const stateController = Parse.CoreManager.getObjectStateController();
  const [pending] = stateController.getPendingOps(identifier);
  this.pendingOps = {
    operations: {
      ...pending
    },
    identifier
  };
  return Promise.resolve().then(() => {
    // Before calling the trigger, validate the permissions for the save operation
    let databasePromise = null;
    if (this.query) {
      // Validate for updating
      databasePromise = this.config.database.update(this.className, this.query, this.data, this.runOptions, true, true);
    } else {
      // Validate for creating
      databasePromise = this.config.database.create(this.className, this.data, this.runOptions, true);
    }
    // In the case that there is no permission for the operation, it throws an error
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
      this.data = response.object;
      // We should delete the objectId for an update write
      if (this.query && this.query.objectId) {
        delete this.data.objectId;
      }
    }
    try {
      Utils.checkProhibitedKeywords(this.config, this.data);
    } catch (error) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, error);
    }
  });
};
RestWrite.prototype.runBeforeLoginTrigger = async function (userData) {
  // Avoid doing any setup for triggers if there is no 'beforeLogin' trigger
  if (!triggers.triggerExists(this.className, triggers.Types.beforeLogin, this.config.applicationId)) {
    return;
  }

  // Cloud code gets a bit of extra data for its objects
  const extraData = {
    className: this.className
  };

  // Expand file objects
  await this.config.filesController.expandFilesInObject(this.config, userData);
  const user = triggers.inflate(extraData, userData);

  // no need to return a response
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

      // add default ACL
      if (schema?.classLevelPermissions?.ACL && !this.data.ACL && JSON.stringify(schema.classLevelPermissions.ACL) !== JSON.stringify({
        '*': {
          read: true,
          write: true
        }
      })) {
        const acl = deepcopy(schema.classLevelPermissions.ACL);
        if (acl.currentUser) {
          if (this.auth.user?.id) {
            acl[this.auth.user?.id] = deepcopy(acl.currentUser);
          }
          delete acl.currentUser;
        }
        this.data.ACL = acl;
        this.storage.fieldsChangedByTrigger = this.storage.fieldsChangedByTrigger || [];
        this.storage.fieldsChangedByTrigger.push('ACL');
      }
      const assignObjectId = () => {
        const objectId = cryptoUtils.newObjectId(this.config.objectIdSize, this.config.objectIdUseTime);
        if (!this.config.objectIdPrefixes) {
          return objectId;
        }
        return this.config.objectIdPrefixes[this.className] ? `${this.config.objectIdPrefixes[this.className]}${objectId}` : objectId;
      };

      // Add default fields
      if (!this.query) {
        // allow customizing createdAt and updatedAt when using maintenance key
        if (this.auth.isMaintenance && this.data.createdAt && this.data.createdAt.__type === 'Date') {
          this.data.createdAt = this.data.createdAt.iso;
          if (this.data.updatedAt && this.data.updatedAt.__type === 'Date') {
            const createdAt = new Date(this.data.createdAt);
            const updatedAt = new Date(this.data.updatedAt.iso);
            if (updatedAt < createdAt) {
              throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'updatedAt cannot occur before createdAt');
            }
            this.data.updatedAt = this.data.updatedAt.iso;
          }
          // if no updatedAt is provided, set it to createdAt to match default behavior
          else {
            this.data.updatedAt = this.data.createdAt;
          }
        } else {
          this.data.updatedAt = this.updatedAt;
          this.data.createdAt = this.updatedAt;
        }

        // Only assign new objectId if we are creating new object
        if (!this.data.objectId) {
          this.data.objectId = assignObjectId();
        }
        if (schema) {
          Object.keys(schema.fields).forEach(fieldName => {
            setRequiredFieldIfNeeded(fieldName, true);
          });
        }
      } else if (schema) {
        this.data.updatedAt = this.updatedAt;
        Object.keys(this.data).forEach(fieldName => {
          setRequiredFieldIfNeeded(fieldName, false);
        });
      }
    });
  }
  return Promise.resolve();
};

// Transforms auth data for a user object.
// Does nothing if this isn't a user object.
// Returns a promise for when we're done if it can't finish this tick.
RestWrite.prototype.validateAuthData = function () {
  if (this.className !== '_User') {
    return;
  }
  const authData = this.data.authData;
  const hasUsernameAndPassword = typeof this.data.username === 'string' && typeof this.data.password === 'string';
  if (!this.query && !authData) {
    if (typeof this.data.username !== 'string' || _lodash.default.isEmpty(this.data.username)) {
      throw new Parse.Error(Parse.Error.USERNAME_MISSING, 'bad or missing username');
    }
    if (typeof this.data.password !== 'string' || _lodash.default.isEmpty(this.data.password)) {
      throw new Parse.Error(Parse.Error.PASSWORD_MISSING, 'password is required');
    }
  }
  if (authData && !Object.keys(authData).length || !Object.prototype.hasOwnProperty.call(this.data, 'authData')) {
    // Nothing to validate here
    return;
  } else if (Object.prototype.hasOwnProperty.call(this.data, 'authData') && !this.data.authData) {
    // Handle saving authData to null
    throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
  }
  var providers = Object.keys(authData);
  if (providers.length > 0) {
    const canHandleAuthData = providers.some(provider => {
      const providerAuthData = authData[provider] || {};
      return !!Object.keys(providerAuthData).length;
    });
    if (canHandleAuthData || hasUsernameAndPassword || this.auth.isMaster || this.getUserId()) {
      return this.handleAuthData(authData);
    }
  }
  throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
};
RestWrite.prototype.filteredObjectsByACL = function (objects) {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return objects;
  }
  return objects.filter(object => {
    if (!object.ACL) {
      return true; // legacy users that have no ACL field on them
    }
    // Regular users that have been locked out.
    return object.ACL && Object.keys(object.ACL).length > 0;
  });
};
RestWrite.prototype.getUserId = function () {
  if (this.query && this.query.objectId && this.className === '_User') {
    return this.query.objectId;
  } else if (this.auth && this.auth.user && this.auth.user.id) {
    return this.auth.user.id;
  }
};

// Developers are allowed to change authData via before save trigger
// we need after before save to ensure that the developer
// is not currently duplicating auth data ID
RestWrite.prototype.ensureUniqueAuthDataId = async function () {
  if (this.className !== '_User' || !this.data.authData) {
    return;
  }
  const hasAuthDataId = Object.keys(this.data.authData).some(key => this.data.authData[key] && this.data.authData[key].id);
  if (!hasAuthDataId) {
    return;
  }
  const r = await Auth.findUsersWithAuthData(this.config, this.data.authData);
  const results = this.filteredObjectsByACL(r);
  if (results.length > 1) {
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }
  // use data.objectId in case of login time and found user during handle validateAuthData
  const userId = this.getUserId() || this.data.objectId;
  if (results.length === 1 && userId !== results[0].objectId) {
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }
};
RestWrite.prototype.handleAuthData = async function (authData) {
  const r = await Auth.findUsersWithAuthData(this.config, authData, true);
  const results = this.filteredObjectsByACL(r);
  const userId = this.getUserId();
  const userResult = results[0];
  const foundUserIsNotCurrentUser = userId && userResult && userId !== userResult.objectId;
  if (results.length > 1 || foundUserIsNotCurrentUser) {
    // To avoid https://github.com/parse-community/parse-server/security/advisories/GHSA-8w3j-g983-8jh5
    // Let's run some validation before throwing
    await Auth.handleAuthDataValidation(authData, this, userResult);
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }

  // No user found with provided authData we need to validate
  if (!results.length) {
    const {
      authData: validatedAuthData,
      authDataResponse
    } = await Auth.handleAuthDataValidation(authData, this);
    this.authDataResponse = authDataResponse;
    // Replace current authData by the new validated one
    this.data.authData = validatedAuthData;
    return;
  }

  // User found with provided authData
  if (results.length === 1) {
    this.storage.authProvider = Object.keys(authData).join(',');
    const {
      hasMutatedAuthData,
      mutatedAuthData
    } = Auth.hasMutatedAuthData(authData, userResult.authData);
    const isCurrentUserLoggedOrMaster = this.auth && this.auth.user && this.auth.user.id === userResult.objectId || this.auth.isMaster;
    const isLogin = !userId;
    if (isLogin || isCurrentUserLoggedOrMaster) {
      // no user making the call
      // OR the user making the call is the right one
      // Login with auth data
      delete results[0].password;

      // need to set the objectId first otherwise location has trailing undefined
      this.data.objectId = userResult.objectId;
      if (!this.query || !this.query.objectId) {
        this.response = {
          response: userResult,
          location: this.location()
        };
        // Run beforeLogin hook before storing any updates
        // to authData on the db; changes to userResult
        // will be ignored.
        await this.runBeforeLoginTrigger(deepcopy(userResult));

        // If we are in login operation via authData
        // we need to be sure that the user has provided
        // required authData
        Auth.checkIfUserHasProvidedConfiguredProvidersForLogin({
          config: this.config,
          auth: this.auth
        }, authData, userResult.authData, this.config);
      }

      // Prevent validating if no mutated data detected on update
      if (!hasMutatedAuthData && isCurrentUserLoggedOrMaster) {
        return;
      }

      // Force to validate all provided authData on login
      // on update only validate mutated ones
      if (hasMutatedAuthData || !this.config.allowExpiredAuthDataToken) {
        const res = await Auth.handleAuthDataValidation(isLogin ? authData : mutatedAuthData, this, userResult);
        this.data.authData = res.authData;
        this.authDataResponse = res.authDataResponse;
      }

      // IF we are in login we'll skip the database operation / beforeSave / afterSave etc...
      // we need to set it up there.
      // We are supposed to have a response only on LOGIN with authData, so we skip those
      // If we're not logging in, but just updating the current user, we can safely skip that part
      if (this.response) {
        // Assign the new authData in the response
        Object.keys(mutatedAuthData).forEach(provider => {
          this.response.response.authData[provider] = mutatedAuthData[provider];
        });

        // Run the DB update directly, as 'master' only if authData contains some keys
        // authData could not contains keys after validation if the authAdapter
        // uses the `doNotSave` option. Just update the authData part
        // Then we're good for the user, early exit of sorts
        if (Object.keys(this.data.authData).length) {
          await this.config.database.update(this.className, {
            objectId: this.data.objectId
          }, {
            authData: this.data.authData
          }, {});
        }
      }
    }
  }
};
RestWrite.prototype.checkRestrictedFields = async function () {
  if (this.className !== '_User') {
    return;
  }
  if (!this.auth.isMaintenance && !this.auth.isMaster && 'emailVerified' in this.data) {
    const error = `Clients aren't allowed to manually update email verification.`;
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, error);
  }
};

// The non-third-party parts of User transformation
RestWrite.prototype.transformUser = async function () {
  var promise = Promise.resolve();
  if (this.className !== '_User') {
    return promise;
  }

  // Do not cleanup session if objectId is not set
  if (this.query && this.objectId()) {
    // If we're updating a _User object, we need to clear out the cache for that user. Find all their
    // session tokens, and remove them from the cache.
    const query = await (0, _RestQuery.default)({
      method: _RestQuery.default.Method.find,
      config: this.config,
      auth: Auth.master(this.config),
      className: '_Session',
      runBeforeFind: false,
      restWhere: {
        user: {
          __type: 'Pointer',
          className: '_User',
          objectId: this.objectId()
        }
      }
    });
    promise = query.execute().then(results => {
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
      this.storage['clearSessions'] = true;
      // Generate a new session only if the user requested
      if (!this.auth.isMaster && !this.auth.isMaintenance) {
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
  }
  /*
    Usernames should be unique when compared case insensitively
     Users should be able to make case sensitive usernames and
    login using the case they entered.  I.e. 'Snoopy' should preclude
    'snoopy' as a valid username.
  */
  return this.config.database.find(this.className, {
    username: this.data.username,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1,
    caseInsensitive: true
  }, {}, this.validSchemaController).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
    }
    return;
  });
};

/*
  As with usernames, Parse should not allow case insensitive collisions of email.
  unlike with usernames (which can have case insensitive collisions in the case of
  auth adapters), emails should never have a case insensitive collision.

  This behavior can be enforced through a properly configured index see:
  https://docs.mongodb.com/manual/core/index-case-insensitive/#create-a-case-insensitive-index
  which could be implemented instead of this code based validation.

  Given that this lookup should be a relatively low use case and that the case sensitive
  unique index will be used by the db for the query, this is an adequate solution.
*/
RestWrite.prototype._validateEmail = function () {
  if (!this.data.email || this.data.email.__op === 'Delete') {
    return Promise.resolve();
  }
  // Validate basic email address format
  if (!this.data.email.match(/^.+@.+$/)) {
    return Promise.reject(new Parse.Error(Parse.Error.INVALID_EMAIL_ADDRESS, 'Email address format is invalid.'));
  }
  // Case insensitive match, see note above function.
  return this.config.database.find(this.className, {
    email: this.data.email,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1,
    caseInsensitive: true
  }, {}, this.validSchemaController).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
    }
    if (!this.data.authData || !Object.keys(this.data.authData).length || Object.keys(this.data.authData).length === 1 && Object.keys(this.data.authData)[0] === 'anonymous') {
      // We updated the email, send a new validation
      const {
        originalObject,
        updatedObject
      } = this.buildParseObjects();
      const request = {
        original: originalObject,
        object: updatedObject,
        master: this.auth.isMaster,
        ip: this.config.ip,
        installationId: this.auth.installationId
      };
      return this.config.userController.setEmailVerifyToken(this.data, request, this.storage);
    }
  });
};
RestWrite.prototype._validatePasswordPolicy = function () {
  if (!this.config.passwordPolicy) {
    return Promise.resolve();
  }
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
  const containsUsernameError = 'Password cannot contain your username.';

  // check whether the password meets the password strength requirements
  if (this.config.passwordPolicy.patternValidator && !this.config.passwordPolicy.patternValidator(this.data.password) || this.config.passwordPolicy.validatorCallback && !this.config.passwordPolicy.validatorCallback(this.data.password)) {
    return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, policyError));
  }

  // check whether password contain username
  if (this.config.passwordPolicy.doNotAllowUsername === true) {
    if (this.data.username) {
      // username is not passed during password reset
      if (this.data.password.indexOf(this.data.username) >= 0) {
        return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
      }
    } else {
      // retrieve the User object using objectId during password reset
      return this.config.database.find('_User', {
        objectId: this.objectId()
      }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }
        if (this.data.password.indexOf(results[0].username) >= 0) {
          return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
        }
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
    }, Auth.maintenance(this.config)).then(results => {
      if (results.length != 1) {
        throw undefined;
      }
      const user = results[0];
      let oldPasswords = [];
      if (user._password_history) {
        oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory - 1);
      }
      oldPasswords.push(user.password);
      const newPassword = this.data.password;
      // compare the new password hash with all old password hashes
      const promises = oldPasswords.map(function (hash) {
        return passwordCrypto.compare(newPassword, hash).then(result => {
          if (result) {
            // reject if there is a match
            return Promise.reject('REPEAT_PASSWORD');
          }
          return Promise.resolve();
        });
      });
      // wait for all comparisons to complete
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      }).catch(err => {
        if (err === 'REPEAT_PASSWORD') {
          // a match was found
          return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, `New password should not be the same as last ${this.config.passwordPolicy.maxPasswordHistory} passwords.`));
        }
        throw err;
      });
    });
  }
  return Promise.resolve();
};
RestWrite.prototype.createSessionTokenIfNeeded = async function () {
  if (this.className !== '_User') {
    return;
  }
  // Don't generate session for updating user (this.query is set) unless authData exists
  if (this.query && !this.data.authData) {
    return;
  }
  // Don't generate new sessionToken if linking via sessionToken
  if (this.auth.user && this.data.authData) {
    return;
  }
  // If sign-up call
  if (!this.storage.authProvider) {
    // Create request object for verification functions
    const {
      originalObject,
      updatedObject
    } = this.buildParseObjects();
    const request = {
      original: originalObject,
      object: updatedObject,
      master: this.auth.isMaster,
      ip: this.config.ip,
      installationId: this.auth.installationId
    };
    // Get verification conditions which can be booleans or functions; the purpose of this async/await
    // structure is to avoid unnecessarily executing subsequent functions if previous ones fail in the
    // conditional statement below, as a developer may decide to execute expensive operations in them
    const verifyUserEmails = async () => this.config.verifyUserEmails === true || typeof this.config.verifyUserEmails === 'function' && (await Promise.resolve(this.config.verifyUserEmails(request))) === true;
    const preventLoginWithUnverifiedEmail = async () => this.config.preventLoginWithUnverifiedEmail === true || typeof this.config.preventLoginWithUnverifiedEmail === 'function' && (await Promise.resolve(this.config.preventLoginWithUnverifiedEmail(request))) === true;
    // If verification is required
    if ((await verifyUserEmails()) && (await preventLoginWithUnverifiedEmail())) {
      this.storage.rejectSignup = true;
      return;
    }
  }
  return this.createSessionToken();
};
RestWrite.prototype.createSessionToken = async function () {
  // cloud installationId from Cloud Code,
  // never create session tokens from there.
  if (this.auth.installationId && this.auth.installationId === 'cloud') {
    return;
  }
  if (this.storage.authProvider == null && this.data.authData) {
    this.storage.authProvider = Object.keys(this.data.authData).join(',');
  }
  const {
    sessionData,
    createSession
  } = RestWrite.createSession(this.config, {
    userId: this.objectId(),
    createdWith: {
      action: this.storage.authProvider ? 'login' : 'signup',
      authProvider: this.storage.authProvider || 'password'
    },
    installationId: this.auth.installationId
  });
  if (this.response && this.response.response) {
    this.response.response.sessionToken = sessionData.sessionToken;
  }
  return createSession();
};
RestWrite.createSession = function (config, {
  userId,
  createdWith,
  installationId,
  additionalSessionData
}) {
  const token = 'r:' + cryptoUtils.newToken();
  const expiresAt = config.generateSessionExpiresAt();
  const sessionData = {
    sessionToken: token,
    user: {
      __type: 'Pointer',
      className: '_User',
      objectId: userId
    },
    createdWith,
    expiresAt: Parse._encode(expiresAt)
  };
  if (installationId) {
    sessionData.installationId = installationId;
  }
  Object.assign(sessionData, additionalSessionData);
  return {
    sessionData,
    createSession: () => new RestWrite(config, Auth.master(config), '_Session', null, sessionData).execute()
  };
};

// Delete email reset tokens if user is changing password or email.
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
  }
  // Destroy the sessions in 'Background'
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
};

// Handles any followup logic
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
    delete this.storage['sendVerificationEmail'];
    // Fire and forget!
    this.config.userController.sendVerificationEmail(this.data, {
      auth: this.auth
    });
    return this.handleFollowup.bind(this);
  }
};

// Handles the _Session class specialness.
// Does nothing if this isn't an _Session object.
RestWrite.prototype.handleSession = function () {
  if (this.response || this.className !== '_Session') {
    return;
  }
  if (!this.auth.user && !this.auth.isMaster && !this.auth.isMaintenance) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token required.');
  }

  // TODO: Verify proper error to throw
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
    if (!this.auth.isMaster) {
      this.query = {
        $and: [this.query, {
          user: {
            __type: 'Pointer',
            className: '_User',
            objectId: this.auth.user.id
          }
        }]
      };
    }
  }
  if (!this.query && !this.auth.isMaster && !this.auth.isMaintenance) {
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
    } = RestWrite.createSession(this.config, {
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
};

// Handles the _Installation class specialness.
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
  }

  // If the device token is 64 characters long, we assume it is for iOS
  // and lowercase it.
  if (this.data.deviceToken && this.data.deviceToken.length == 64) {
    this.data.deviceToken = this.data.deviceToken.toLowerCase();
  }

  // We lowercase the installationId if present
  if (this.data.installationId) {
    this.data.installationId = this.data.installationId.toLowerCase();
  }
  let installationId = this.data.installationId;

  // If data.installationId is not set and we're not master, we can lookup in auth
  if (!installationId && !this.auth.isMaster && !this.auth.isMaintenance) {
    installationId = this.auth.installationId;
  }
  if (installationId) {
    installationId = installationId.toLowerCase();
  }

  // Updating _Installation but not updating anything critical
  if (this.query && !this.data.deviceToken && !installationId && !this.data.deviceType) {
    return;
  }
  var promise = Promise.resolve();
  var idMatch; // Will be a match on either objectId or installationId
  var objectIdMatch;
  var installationIdMatch;
  var deviceTokenMatches = [];

  // Instead of issuing 3 reads, let's do it with one OR.
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
    });

    // Sanity checks when running a query
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
    }
    // need to specify deviceType only if it's new
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
          }
          // rethrow the error
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
          }
          // rethrow the error
          throw err;
        });
      } else {
        if (this.data.deviceToken && idMatch.deviceToken != this.data.deviceToken) {
          // We're setting the device token on an existing installation, so
          // we should try cleaning out old installations that match this
          // device token.
          const delQuery = {
            deviceToken: this.data.deviceToken
          };
          // We have a unique install Id, use that to preserve
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
            }
            // rethrow the error
            throw err;
          });
        }
        // In non-merge scenarios, just return the installation match id
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
    }
    // TODO: Validate ops (add/remove on channels, $inc on badge, etc.)
  });
  return promise;
};

// If we short-circuited the object response - then we need to make sure we expand all the files,
// since this might not have a query, meaning it won't return the full result back.
// TODO: (nlutsenko) This should die when we move to per-class based controllers on _Session/_User
RestWrite.prototype.expandFilesForExistingObjects = async function () {
  // Check whether we have a short-circuited response - only then run expansion.
  if (this.response && this.response.response) {
    await this.config.filesController.expandFilesInObject(this.config, this.response.response);
  }
};
RestWrite.prototype.runDatabaseOperation = function () {
  if (this.response) {
    return;
  }
  if (this.className === '_Role') {
    this.config.cacheController.role.clear();
    if (this.config.liveQueryController) {
      this.config.liveQueryController.clearCachedRoles(this.auth.user);
    }
  }
  if (this.className === '_User' && this.query && this.auth.isUnauthenticated()) {
    throw new Parse.Error(Parse.Error.SESSION_MISSING, `Cannot modify user ${this.query.objectId}.`);
  }
  if (this.className === '_Product' && this.data.download) {
    this.data.downloadName = this.data.download.name;
  }

  // TODO: Add better detection for ACL, ensuring a user can't be locked from
  //       their own user record.
  if (this.data.ACL && this.data.ACL['*unresolved']) {
    throw new Parse.Error(Parse.Error.INVALID_ACL, 'Invalid ACL.');
  }
  if (this.query) {
    // Force the user to not lockout
    // Matched with parse.com
    if (this.className === '_User' && this.data.ACL && this.auth.isMaster !== true && this.auth.isMaintenance !== true) {
      this.data.ACL[this.query.objectId] = {
        read: true,
        write: true
      };
    }
    // update password timestamp if user password is being changed
    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
      this.data._password_changed_at = Parse._encode(new Date());
    }
    // Ignore createdAt when update
    delete this.data.createdAt;
    let defer = Promise.resolve();
    // if password history is enabled then save the current password to history
    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordHistory) {
      defer = this.config.database.find('_User', {
        objectId: this.objectId()
      }, {
        keys: ['_password_history', '_hashed_password']
      }, Auth.maintenance(this.config)).then(results => {
        if (results.length != 1) {
          throw undefined;
        }
        const user = results[0];
        let oldPasswords = [];
        if (user._password_history) {
          oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory);
        }
        //n-1 passwords go into history including last password
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
      var ACL = this.data.ACL;
      // default public r/w ACL
      if (!ACL) {
        ACL = {};
        if (!this.config.enforcePrivateUsers) {
          ACL['*'] = {
            read: true,
            write: false
          };
        }
      }
      // make sure the user is not locked down
      ACL[this.data.objectId] = {
        read: true,
        write: true
      };
      this.data.ACL = ACL;
      // password timestamp to be used when password expiry policy is enforced
      if (this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
        this.data._password_changed_at = Parse._encode(new Date());
      }
    }

    // Run a create
    return this.config.database.create(this.className, this.data, this.runOptions, false, this.validSchemaController).catch(error => {
      if (this.className !== '_User' || error.code !== Parse.Error.DUPLICATE_VALUE) {
        throw error;
      }

      // Quick check, if we were able to infer the duplicated field name
      if (error && error.userInfo && error.userInfo.duplicated_field === 'username') {
        throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
      }
      if (error && error.userInfo && error.userInfo.duplicated_field === 'email') {
        throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
      }

      // If this was a failed user creation due to username or email already taken, we need to
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
};

// Returns nothing - doesn't wait for the trigger.
RestWrite.prototype.runAfterSaveTrigger = function () {
  if (!this.response || !this.response.response || this.runOptions.many) {
    return;
  }

  // Avoid doing any setup for triggers if there is no 'afterSave' trigger for this class.
  const hasAfterSaveHook = triggers.triggerExists(this.className, triggers.Types.afterSave, this.config.applicationId);
  const hasLiveQuery = this.config.liveQueryController.hasLiveQuery(this.className);
  if (!hasAfterSaveHook && !hasLiveQuery) {
    return Promise.resolve();
  }
  const {
    originalObject,
    updatedObject
  } = this.buildParseObjects();
  updatedObject._handleSaveResponse(this.response.response, this.response.status || 200);
  if (hasLiveQuery) {
    this.config.database.loadSchema().then(schemaController => {
      // Notify LiveQueryServer if possible
      const perms = schemaController.getClassLevelPermissions(updatedObject.className);
      this.config.liveQueryController.onAfterSave(updatedObject.className, updatedObject, originalObject, perms);
    });
  }
  if (!hasAfterSaveHook) {
    return Promise.resolve();
  }
  // Run afterSave trigger
  return triggers.maybeRunTrigger(triggers.Types.afterSave, this.auth, updatedObject, originalObject, this.config, this.context).then(result => {
    const jsonReturned = result && !result._toFullJSON;
    if (jsonReturned) {
      this.pendingOps.operations = {};
      this.response.response = result;
    } else {
      this.response.response = this._updateResponseWithData((result || updatedObject).toJSON(), this.data);
    }
  }).catch(function (err) {
    _logger.default.warn('afterSave caught an error', err);
  });
};

// A helper to figure out what location this operation happens at.
RestWrite.prototype.location = function () {
  var middle = this.className === '_User' ? '/users/' : '/classes/' + this.className + '/';
  const mount = this.config.mount || this.config.serverURL;
  return mount + middle + this.data.objectId;
};

// A helper to get the object id for this operation.
// Because it could be either on the query or on the data
RestWrite.prototype.objectId = function () {
  return this.data.objectId || this.query.objectId;
};

// Returns a copy of the data and delete bad keys (_auth_data, _hashed_password...)
RestWrite.prototype.sanitizedData = function () {
  const data = Object.keys(this.data).reduce((data, key) => {
    // Regexp comes from Parse.Object.prototype.validate
    if (!/^[A-Za-z][0-9A-Za-z_]*$/.test(key)) {
      delete data[key];
    }
    return data;
  }, deepcopy(this.data));
  return Parse._decode(undefined, data);
};

// Returns an updated copy of the object
RestWrite.prototype.buildParseObjects = function () {
  const extraData = {
    className: this.className,
    objectId: this.query?.objectId
  };
  let originalObject;
  if (this.query && this.query.objectId) {
    originalObject = triggers.inflate(extraData, this.originalData);
  }
  const className = Parse.Object.fromJSON(extraData);
  const readOnlyAttributes = className.constructor.readOnlyAttributes ? className.constructor.readOnlyAttributes() : [];
  if (!this.originalData) {
    for (const attribute of readOnlyAttributes) {
      extraData[attribute] = this.data[attribute];
    }
  }
  const updatedObject = triggers.inflate(extraData, this.originalData);
  Object.keys(this.data).reduce(function (data, key) {
    if (key.indexOf('.') > 0) {
      if (typeof data[key].__op === 'string') {
        if (!readOnlyAttributes.includes(key)) {
          updatedObject.set(key, data[key]);
        }
      } else {
        // subdocument key with dot notation { 'x.y': v } => { 'x': { 'y' : v } })
        const splittedKey = key.split('.');
        const parentProp = splittedKey[0];
        let parentVal = updatedObject.get(parentProp);
        if (typeof parentVal !== 'object') {
          parentVal = {};
        }
        parentVal[splittedKey[1]] = data[key];
        updatedObject.set(parentProp, parentVal);
      }
      delete data[key];
    }
    return data;
  }, deepcopy(this.data));
  const sanitized = this.sanitizedData();
  for (const attribute of readOnlyAttributes) {
    delete sanitized[attribute];
  }
  updatedObject.set(sanitized);
  return {
    updatedObject,
    originalObject
  };
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
  const stateController = Parse.CoreManager.getObjectStateController();
  const [pending] = stateController.getPendingOps(this.pendingOps.identifier);
  for (const key in this.pendingOps.operations) {
    if (!pending[key]) {
      data[key] = this.originalData ? this.originalData[key] : {
        __op: 'Delete'
      };
      this.storage.fieldsChangedByTrigger.push(key);
    }
  }
  const skipKeys = [...(_SchemaController.requiredColumns.read[this.className] || [])];
  if (!this.query) {
    skipKeys.push('objectId', 'createdAt');
  } else {
    skipKeys.push('updatedAt');
    delete response.objectId;
  }
  for (const key in response) {
    if (skipKeys.includes(key)) {
      continue;
    }
    const value = response[key];
    if (value == null || value.__type && value.__type === 'Pointer' || util.isDeepStrictEqual(data[key], value) || util.isDeepStrictEqual((this.originalData || {})[key], value)) {
      delete response[key];
    }
  }
  if (_lodash.default.isEmpty(this.storage.fieldsChangedByTrigger)) {
    return response;
  }
  const clientSupportsDelete = ClientSDK.supportsForwardDelete(this.clientSDK);
  this.storage.fieldsChangedByTrigger.forEach(fieldName => {
    const dataValue = data[fieldName];
    if (!Object.prototype.hasOwnProperty.call(response, fieldName)) {
      response[fieldName] = dataValue;
    }

    // Strips operations from responses
    if (response[fieldName] && response[fieldName].__op) {
      delete response[fieldName];
      if (clientSupportsDelete && dataValue.__op == 'Delete') {
        response[fieldName] = dataValue;
      }
    }
  });
  return response;
};
var _default = exports.default = RestWrite;
module.exports = RestWrite;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUmVzdFF1ZXJ5IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9TY2hlbWFDb250cm9sbGVyIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiU2NoZW1hQ29udHJvbGxlciIsImRlZXBjb3B5IiwiQXV0aCIsIlV0aWxzIiwiY3J5cHRvVXRpbHMiLCJwYXNzd29yZENyeXB0byIsIlBhcnNlIiwidHJpZ2dlcnMiLCJDbGllbnRTREsiLCJ1dGlsIiwiUmVzdFdyaXRlIiwiY29uZmlnIiwiYXV0aCIsImNsYXNzTmFtZSIsInF1ZXJ5IiwiZGF0YSIsIm9yaWdpbmFsRGF0YSIsImNsaWVudFNESyIsImNvbnRleHQiLCJhY3Rpb24iLCJpc1JlYWRPbmx5IiwiRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwic3RvcmFnZSIsInJ1bk9wdGlvbnMiLCJhbGxvd0N1c3RvbU9iamVjdElkIiwiT2JqZWN0IiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwib2JqZWN0SWQiLCJNSVNTSU5HX09CSkVDVF9JRCIsIklOVkFMSURfS0VZX05BTUUiLCJpZCIsInJlc3BvbnNlIiwidXBkYXRlZEF0IiwiX2VuY29kZSIsIkRhdGUiLCJpc28iLCJ2YWxpZFNjaGVtYUNvbnRyb2xsZXIiLCJwZW5kaW5nT3BzIiwib3BlcmF0aW9ucyIsImlkZW50aWZpZXIiLCJleGVjdXRlIiwiUHJvbWlzZSIsInJlc29sdmUiLCJ0aGVuIiwiZ2V0VXNlckFuZFJvbGVBQ0wiLCJ2YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24iLCJoYW5kbGVJbnN0YWxsYXRpb24iLCJoYW5kbGVTZXNzaW9uIiwidmFsaWRhdGVBdXRoRGF0YSIsImNoZWNrUmVzdHJpY3RlZEZpZWxkcyIsInJ1bkJlZm9yZVNhdmVUcmlnZ2VyIiwiZW5zdXJlVW5pcXVlQXV0aERhdGFJZCIsImRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkIiwidmFsaWRhdGVTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwic2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCIsInRyYW5zZm9ybVVzZXIiLCJleHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyIsImRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMiLCJydW5EYXRhYmFzZU9wZXJhdGlvbiIsImNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkIiwiaGFuZGxlRm9sbG93dXAiLCJydW5BZnRlclNhdmVUcmlnZ2VyIiwiY2xlYW5Vc2VyQXV0aERhdGEiLCJhdXRoRGF0YVJlc3BvbnNlIiwicmVqZWN0U2lnbnVwIiwicHJldmVudFNpZ251cFdpdGhVbnZlcmlmaWVkRW1haWwiLCJFTUFJTF9OT1RfRk9VTkQiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJhY2wiLCJ1c2VyIiwiZ2V0VXNlclJvbGVzIiwicm9sZXMiLCJjb25jYXQiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwiaW5kZXhPZiIsImRhdGFiYXNlIiwibG9hZFNjaGVtYSIsImhhc0NsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJtYW55IiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYmVmb3JlU2F2ZSIsImFwcGxpY2F0aW9uSWQiLCJvcmlnaW5hbE9iamVjdCIsInVwZGF0ZWRPYmplY3QiLCJidWlsZFBhcnNlT2JqZWN0cyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJzdGF0ZUNvbnRyb2xsZXIiLCJDb3JlTWFuYWdlciIsImdldE9iamVjdFN0YXRlQ29udHJvbGxlciIsInBlbmRpbmciLCJnZXRQZW5kaW5nT3BzIiwiZGF0YWJhc2VQcm9taXNlIiwidXBkYXRlIiwiY3JlYXRlIiwicmVzdWx0IiwibGVuZ3RoIiwiT0JKRUNUX05PVF9GT1VORCIsIm1heWJlUnVuVHJpZ2dlciIsIm9iamVjdCIsImZpZWxkc0NoYW5nZWRCeVRyaWdnZXIiLCJfIiwicmVkdWNlIiwidmFsdWUiLCJrZXkiLCJpc0VxdWFsIiwicHVzaCIsImNoZWNrUHJvaGliaXRlZEtleXdvcmRzIiwiZXJyb3IiLCJydW5CZWZvcmVMb2dpblRyaWdnZXIiLCJ1c2VyRGF0YSIsImJlZm9yZUxvZ2luIiwiZXh0cmFEYXRhIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsImluZmxhdGUiLCJnZXRBbGxDbGFzc2VzIiwiYWxsQ2xhc3NlcyIsInNjaGVtYSIsImZpbmQiLCJvbmVDbGFzcyIsInNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCIsImZpZWxkTmFtZSIsInNldERlZmF1bHQiLCJ1bmRlZmluZWQiLCJfX29wIiwiZmllbGRzIiwiZGVmYXVsdFZhbHVlIiwicmVxdWlyZWQiLCJWQUxJREFUSU9OX0VSUk9SIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiQUNMIiwiSlNPTiIsInN0cmluZ2lmeSIsInJlYWQiLCJ3cml0ZSIsImN1cnJlbnRVc2VyIiwiYXNzaWduT2JqZWN0SWQiLCJuZXdPYmplY3RJZCIsIm9iamVjdElkU2l6ZSIsIm9iamVjdElkVXNlVGltZSIsIm9iamVjdElkUHJlZml4ZXMiLCJjcmVhdGVkQXQiLCJfX3R5cGUiLCJrZXlzIiwiZm9yRWFjaCIsImF1dGhEYXRhIiwiaGFzVXNlcm5hbWVBbmRQYXNzd29yZCIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJpc0VtcHR5IiwiVVNFUk5BTUVfTUlTU0lORyIsIlBBU1NXT1JEX01JU1NJTkciLCJVTlNVUFBPUlRFRF9TRVJWSUNFIiwicHJvdmlkZXJzIiwiY2FuSGFuZGxlQXV0aERhdGEiLCJzb21lIiwicHJvdmlkZXIiLCJwcm92aWRlckF1dGhEYXRhIiwiZ2V0VXNlcklkIiwiaGFuZGxlQXV0aERhdGEiLCJmaWx0ZXJlZE9iamVjdHNCeUFDTCIsIm9iamVjdHMiLCJmaWx0ZXIiLCJoYXNBdXRoRGF0YUlkIiwiciIsImZpbmRVc2Vyc1dpdGhBdXRoRGF0YSIsInJlc3VsdHMiLCJBQ0NPVU5UX0FMUkVBRFlfTElOS0VEIiwidXNlcklkIiwidXNlclJlc3VsdCIsImZvdW5kVXNlcklzTm90Q3VycmVudFVzZXIiLCJoYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24iLCJ2YWxpZGF0ZWRBdXRoRGF0YSIsImF1dGhQcm92aWRlciIsImpvaW4iLCJoYXNNdXRhdGVkQXV0aERhdGEiLCJtdXRhdGVkQXV0aERhdGEiLCJpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIiLCJpc0xvZ2luIiwibG9jYXRpb24iLCJjaGVja0lmVXNlckhhc1Byb3ZpZGVkQ29uZmlndXJlZFByb3ZpZGVyc0ZvckxvZ2luIiwiYWxsb3dFeHBpcmVkQXV0aERhdGFUb2tlbiIsInJlcyIsInByb21pc2UiLCJSZXN0UXVlcnkiLCJtZXRob2QiLCJNZXRob2QiLCJtYXN0ZXIiLCJydW5CZWZvcmVGaW5kIiwicmVzdFdoZXJlIiwic2Vzc2lvbiIsImNhY2hlQ29udHJvbGxlciIsImRlbCIsInNlc3Npb25Ub2tlbiIsIl92YWxpZGF0ZVBhc3N3b3JkUG9saWN5IiwiaGFzaCIsImhhc2hlZFBhc3N3b3JkIiwiX2hhc2hlZF9wYXNzd29yZCIsIl92YWxpZGF0ZVVzZXJOYW1lIiwiX3ZhbGlkYXRlRW1haWwiLCJyYW5kb21TdHJpbmciLCJyZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSIsIiRuZSIsImxpbWl0IiwiY2FzZUluc2Vuc2l0aXZlIiwiVVNFUk5BTUVfVEFLRU4iLCJlbWFpbCIsIm1hdGNoIiwicmVqZWN0IiwiSU5WQUxJRF9FTUFJTF9BRERSRVNTIiwiRU1BSUxfVEFLRU4iLCJyZXF1ZXN0Iiwib3JpZ2luYWwiLCJpcCIsImluc3RhbGxhdGlvbklkIiwidXNlckNvbnRyb2xsZXIiLCJzZXRFbWFpbFZlcmlmeVRva2VuIiwicGFzc3dvcmRQb2xpY3kiLCJfdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cyIsIl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSIsInBvbGljeUVycm9yIiwidmFsaWRhdGlvbkVycm9yIiwiY29udGFpbnNVc2VybmFtZUVycm9yIiwicGF0dGVyblZhbGlkYXRvciIsInZhbGlkYXRvckNhbGxiYWNrIiwiZG9Ob3RBbGxvd1VzZXJuYW1lIiwibWF4UGFzc3dvcmRIaXN0b3J5IiwibWFpbnRlbmFuY2UiLCJvbGRQYXNzd29yZHMiLCJfcGFzc3dvcmRfaGlzdG9yeSIsInRha2UiLCJuZXdQYXNzd29yZCIsInByb21pc2VzIiwibWFwIiwiY29tcGFyZSIsImFsbCIsImNhdGNoIiwiZXJyIiwidmVyaWZ5VXNlckVtYWlscyIsInByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwiLCJjcmVhdGVTZXNzaW9uVG9rZW4iLCJzZXNzaW9uRGF0YSIsImNyZWF0ZVNlc3Npb24iLCJjcmVhdGVkV2l0aCIsImFkZGl0aW9uYWxTZXNzaW9uRGF0YSIsInRva2VuIiwibmV3VG9rZW4iLCJleHBpcmVzQXQiLCJnZW5lcmF0ZVNlc3Npb25FeHBpcmVzQXQiLCJhc3NpZ24iLCJhZGRPcHMiLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJkZXN0cm95IiwicmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCIsInNlc3Npb25RdWVyeSIsImJpbmQiLCJzZW5kVmVyaWZpY2F0aW9uRW1haWwiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCIkYW5kIiwiSU5URVJOQUxfU0VSVkVSX0VSUk9SIiwic3RhdHVzIiwiZGV2aWNlVG9rZW4iLCJ0b0xvd2VyQ2FzZSIsImRldmljZVR5cGUiLCJpZE1hdGNoIiwib2JqZWN0SWRNYXRjaCIsImluc3RhbGxhdGlvbklkTWF0Y2giLCJkZXZpY2VUb2tlbk1hdGNoZXMiLCJvclF1ZXJpZXMiLCIkb3IiLCJkZWxRdWVyeSIsImFwcElkZW50aWZpZXIiLCJjb2RlIiwib2JqSWQiLCJyb2xlIiwiY2xlYXIiLCJsaXZlUXVlcnlDb250cm9sbGVyIiwiY2xlYXJDYWNoZWRSb2xlcyIsImlzVW5hdXRoZW50aWNhdGVkIiwiU0VTU0lPTl9NSVNTSU5HIiwiZG93bmxvYWQiLCJkb3dubG9hZE5hbWUiLCJuYW1lIiwiSU5WQUxJRF9BQ0wiLCJtYXhQYXNzd29yZEFnZSIsIl9wYXNzd29yZF9jaGFuZ2VkX2F0IiwiZGVmZXIiLCJNYXRoIiwibWF4Iiwic2hpZnQiLCJfdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSIsImVuZm9yY2VQcml2YXRlVXNlcnMiLCJEVVBMSUNBVEVfVkFMVUUiLCJ1c2VySW5mbyIsImR1cGxpY2F0ZWRfZmllbGQiLCJoYXNBZnRlclNhdmVIb29rIiwiYWZ0ZXJTYXZlIiwiaGFzTGl2ZVF1ZXJ5IiwiX2hhbmRsZVNhdmVSZXNwb25zZSIsInBlcm1zIiwiZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zIiwib25BZnRlclNhdmUiLCJqc29uUmV0dXJuZWQiLCJfdG9GdWxsSlNPTiIsInRvSlNPTiIsImxvZ2dlciIsIndhcm4iLCJtaWRkbGUiLCJtb3VudCIsInNlcnZlclVSTCIsInNhbml0aXplZERhdGEiLCJ0ZXN0IiwiX2RlY29kZSIsImZyb21KU09OIiwicmVhZE9ubHlBdHRyaWJ1dGVzIiwiY29uc3RydWN0b3IiLCJhdHRyaWJ1dGUiLCJpbmNsdWRlcyIsInNldCIsInNwbGl0dGVkS2V5Iiwic3BsaXQiLCJwYXJlbnRQcm9wIiwicGFyZW50VmFsIiwiZ2V0Iiwic2FuaXRpemVkIiwic2tpcEtleXMiLCJyZXF1aXJlZENvbHVtbnMiLCJpc0RlZXBTdHJpY3RFcXVhbCIsImNsaWVudFN1cHBvcnRzRGVsZXRlIiwic3VwcG9ydHNGb3J3YXJkRGVsZXRlIiwiZGF0YVZhbHVlIiwiX2RlZmF1bHQiLCJleHBvcnRzIiwibW9kdWxlIl0sInNvdXJjZXMiOlsiLi4vc3JjL1Jlc3RXcml0ZS5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBBIFJlc3RXcml0ZSBlbmNhcHN1bGF0ZXMgZXZlcnl0aGluZyB3ZSBuZWVkIHRvIHJ1biBhbiBvcGVyYXRpb25cbi8vIHRoYXQgd3JpdGVzIHRvIHRoZSBkYXRhYmFzZS5cbi8vIFRoaXMgY291bGQgYmUgZWl0aGVyIGEgXCJjcmVhdGVcIiBvciBhbiBcInVwZGF0ZVwiLlxuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xudmFyIGRlZXBjb3B5ID0gcmVxdWlyZSgnZGVlcGNvcHknKTtcblxuY29uc3QgQXV0aCA9IHJlcXVpcmUoJy4vQXV0aCcpO1xuY29uc3QgVXRpbHMgPSByZXF1aXJlKCcuL1V0aWxzJyk7XG52YXIgY3J5cHRvVXRpbHMgPSByZXF1aXJlKCcuL2NyeXB0b1V0aWxzJyk7XG52YXIgcGFzc3dvcmRDcnlwdG8gPSByZXF1aXJlKCcuL3Bhc3N3b3JkJyk7XG52YXIgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJyk7XG52YXIgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG52YXIgQ2xpZW50U0RLID0gcmVxdWlyZSgnLi9DbGllbnRTREsnKTtcbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5pbXBvcnQgUmVzdFF1ZXJ5IGZyb20gJy4vUmVzdFF1ZXJ5JztcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCB7IHJlcXVpcmVkQ29sdW1ucyB9IGZyb20gJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcic7XG5cbi8vIHF1ZXJ5IGFuZCBkYXRhIGFyZSBib3RoIHByb3ZpZGVkIGluIFJFU1QgQVBJIGZvcm1hdC4gU28gZGF0YVxuLy8gdHlwZXMgYXJlIGVuY29kZWQgYnkgcGxhaW4gb2xkIG9iamVjdHMuXG4vLyBJZiBxdWVyeSBpcyBudWxsLCB0aGlzIGlzIGEgXCJjcmVhdGVcIiBhbmQgdGhlIGRhdGEgaW4gZGF0YSBzaG91bGQgYmVcbi8vIGNyZWF0ZWQuXG4vLyBPdGhlcndpc2UgdGhpcyBpcyBhbiBcInVwZGF0ZVwiIC0gdGhlIG9iamVjdCBtYXRjaGluZyB0aGUgcXVlcnlcbi8vIHNob3VsZCBnZXQgdXBkYXRlZCB3aXRoIGRhdGEuXG4vLyBSZXN0V3JpdGUgd2lsbCBoYW5kbGUgb2JqZWN0SWQsIGNyZWF0ZWRBdCwgYW5kIHVwZGF0ZWRBdCBmb3Jcbi8vIGV2ZXJ5dGhpbmcuIEl0IGFsc28ga25vd3MgdG8gdXNlIHRyaWdnZXJzIGFuZCBzcGVjaWFsIG1vZGlmaWNhdGlvbnNcbi8vIGZvciB0aGUgX1VzZXIgY2xhc3MuXG5mdW5jdGlvbiBSZXN0V3JpdGUoY29uZmlnLCBhdXRoLCBjbGFzc05hbWUsIHF1ZXJ5LCBkYXRhLCBvcmlnaW5hbERhdGEsIGNsaWVudFNESywgY29udGV4dCwgYWN0aW9uKSB7XG4gIGlmIChhdXRoLmlzUmVhZE9ubHkpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgJ0Nhbm5vdCBwZXJmb3JtIGEgd3JpdGUgb3BlcmF0aW9uIHdoZW4gdXNpbmcgcmVhZE9ubHlNYXN0ZXJLZXknXG4gICAgKTtcbiAgfVxuICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgdGhpcy5hdXRoID0gYXV0aDtcbiAgdGhpcy5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gIHRoaXMuY2xpZW50U0RLID0gY2xpZW50U0RLO1xuICB0aGlzLnN0b3JhZ2UgPSB7fTtcbiAgdGhpcy5ydW5PcHRpb25zID0ge307XG4gIHRoaXMuY29udGV4dCA9IGNvbnRleHQgfHwge307XG5cbiAgaWYgKGFjdGlvbikge1xuICAgIHRoaXMucnVuT3B0aW9ucy5hY3Rpb24gPSBhY3Rpb247XG4gIH1cblxuICBpZiAoIXF1ZXJ5KSB7XG4gICAgaWYgKHRoaXMuY29uZmlnLmFsbG93Q3VzdG9tT2JqZWN0SWQpIHtcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoZGF0YSwgJ29iamVjdElkJykgJiYgIWRhdGEub2JqZWN0SWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLk1JU1NJTkdfT0JKRUNUX0lELFxuICAgICAgICAgICdvYmplY3RJZCBtdXN0IG5vdCBiZSBlbXB0eSwgbnVsbCBvciB1bmRlZmluZWQnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChkYXRhLm9iamVjdElkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnb2JqZWN0SWQgaXMgYW4gaW52YWxpZCBmaWVsZCBuYW1lLicpO1xuICAgICAgfVxuICAgICAgaWYgKGRhdGEuaWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdpZCBpcyBhbiBpbnZhbGlkIGZpZWxkIG5hbWUuJyk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gV2hlbiB0aGUgb3BlcmF0aW9uIGlzIGNvbXBsZXRlLCB0aGlzLnJlc3BvbnNlIG1heSBoYXZlIHNldmVyYWxcbiAgLy8gZmllbGRzLlxuICAvLyByZXNwb25zZTogdGhlIGFjdHVhbCBkYXRhIHRvIGJlIHJldHVybmVkXG4gIC8vIHN0YXR1czogdGhlIGh0dHAgc3RhdHVzIGNvZGUuIGlmIG5vdCBwcmVzZW50LCB0cmVhdGVkIGxpa2UgYSAyMDBcbiAgLy8gbG9jYXRpb246IHRoZSBsb2NhdGlvbiBoZWFkZXIuIGlmIG5vdCBwcmVzZW50LCBubyBsb2NhdGlvbiBoZWFkZXJcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG5cbiAgLy8gUHJvY2Vzc2luZyB0aGlzIG9wZXJhdGlvbiBtYXkgbXV0YXRlIG91ciBkYXRhLCBzbyB3ZSBvcGVyYXRlIG9uIGFcbiAgLy8gY29weVxuICB0aGlzLnF1ZXJ5ID0gZGVlcGNvcHkocXVlcnkpO1xuICB0aGlzLmRhdGEgPSBkZWVwY29weShkYXRhKTtcbiAgLy8gV2UgbmV2ZXIgY2hhbmdlIG9yaWdpbmFsRGF0YSwgc28gd2UgZG8gbm90IG5lZWQgYSBkZWVwIGNvcHlcbiAgdGhpcy5vcmlnaW5hbERhdGEgPSBvcmlnaW5hbERhdGE7XG5cbiAgLy8gVGhlIHRpbWVzdGFtcCB3ZSdsbCB1c2UgZm9yIHRoaXMgd2hvbGUgb3BlcmF0aW9uXG4gIHRoaXMudXBkYXRlZEF0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKS5pc287XG5cbiAgLy8gU2hhcmVkIFNjaGVtYUNvbnRyb2xsZXIgdG8gYmUgcmV1c2VkIHRvIHJlZHVjZSB0aGUgbnVtYmVyIG9mIGxvYWRTY2hlbWEoKSBjYWxscyBwZXIgcmVxdWVzdFxuICAvLyBPbmNlIHNldCB0aGUgc2NoZW1hRGF0YSBzaG91bGQgYmUgaW1tdXRhYmxlXG4gIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyID0gbnVsbDtcbiAgdGhpcy5wZW5kaW5nT3BzID0ge1xuICAgIG9wZXJhdGlvbnM6IG51bGwsXG4gICAgaWRlbnRpZmllcjogbnVsbCxcbiAgfTtcbn1cblxuLy8gQSBjb252ZW5pZW50IG1ldGhvZCB0byBwZXJmb3JtIGFsbCB0aGUgc3RlcHMgb2YgcHJvY2Vzc2luZyB0aGVcbi8vIHdyaXRlLCBpbiBvcmRlci5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIHtyZXNwb25zZSwgc3RhdHVzLCBsb2NhdGlvbn0gb2JqZWN0LlxuLy8gc3RhdHVzIGFuZCBsb2NhdGlvbiBhcmUgb3B0aW9uYWwuXG5SZXN0V3JpdGUucHJvdG90eXBlLmV4ZWN1dGUgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmdldFVzZXJBbmRSb2xlQUNMKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluc3RhbGxhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlU2Vzc2lvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVBdXRoRGF0YSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY2hlY2tSZXN0cmljdGVkRmllbGRzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5CZWZvcmVTYXZlVHJpZ2dlcigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZW5zdXJlVW5pcXVlQXV0aERhdGFJZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlU2NoZW1hKCk7XG4gICAgfSlcbiAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyID0gc2NoZW1hQ29udHJvbGxlcjtcbiAgICAgIHJldHVybiB0aGlzLnNldFJlcXVpcmVkRmllbGRzSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnRyYW5zZm9ybVVzZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5EYXRhYmFzZU9wZXJhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5BZnRlclNhdmVUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jbGVhblVzZXJBdXRoRGF0YSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gQXBwZW5kIHRoZSBhdXRoRGF0YVJlc3BvbnNlIGlmIGV4aXN0c1xuICAgICAgaWYgKHRoaXMuYXV0aERhdGFSZXNwb25zZSkge1xuICAgICAgICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5hdXRoRGF0YVJlc3BvbnNlID0gdGhpcy5hdXRoRGF0YVJlc3BvbnNlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5zdG9yYWdlLnJlamVjdFNpZ251cCAmJiB0aGlzLmNvbmZpZy5wcmV2ZW50U2lnbnVwV2l0aFVudmVyaWZpZWRFbWFpbCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRU1BSUxfTk9UX0ZPVU5ELCAnVXNlciBlbWFpbCBpcyBub3QgdmVyaWZpZWQuJyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5yZXNwb25zZTtcbiAgICB9KTtcbn07XG5cbi8vIFVzZXMgdGhlIEF1dGggb2JqZWN0IHRvIGdldCB0aGUgbGlzdCBvZiByb2xlcywgYWRkcyB0aGUgdXNlciBpZFxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VyQW5kUm9sZUFDTCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMucnVuT3B0aW9ucy5hY2wgPSBbJyonXTtcblxuICBpZiAodGhpcy5hdXRoLnVzZXIpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLmdldFVzZXJSb2xlcygpLnRoZW4ocm9sZXMgPT4ge1xuICAgICAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IHRoaXMucnVuT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbdGhpcy5hdXRoLnVzZXIuaWRdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmIChcbiAgICB0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmXG4gICAgIXRoaXMuYXV0aC5pc01hc3RlciAmJlxuICAgICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJlxuICAgIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTFcbiAgKSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgJ1RoaXMgdXNlciBpcyBub3QgYWxsb3dlZCB0byBhY2Nlc3MgJyArICdub24tZXhpc3RlbnQgY2xhc3M6ICcgKyB0aGlzLmNsYXNzTmFtZVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIHNjaGVtYS5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVTY2hlbWEgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS52YWxpZGF0ZU9iamVjdChcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0aGlzLmRhdGEsXG4gICAgdGhpcy5xdWVyeSxcbiAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2VcbiAgKTtcbn07XG5cbi8vIFJ1bnMgYW55IGJlZm9yZVNhdmUgdHJpZ2dlcnMgYWdhaW5zdCB0aGlzIG9wZXJhdGlvbi5cbi8vIEFueSBjaGFuZ2UgbGVhZHMgdG8gb3VyIGRhdGEgYmVpbmcgbXV0YXRlZC5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQmVmb3JlU2F2ZVRyaWdnZXIgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMucnVuT3B0aW9ucy5tYW55KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYmVmb3JlU2F2ZScgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgaWYgKFxuICAgICF0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKHRoaXMuY2xhc3NOYW1lLCB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLCB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkKVxuICApIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjb25zdCB7IG9yaWdpbmFsT2JqZWN0LCB1cGRhdGVkT2JqZWN0IH0gPSB0aGlzLmJ1aWxkUGFyc2VPYmplY3RzKCk7XG4gIGNvbnN0IGlkZW50aWZpZXIgPSB1cGRhdGVkT2JqZWN0Ll9nZXRTdGF0ZUlkZW50aWZpZXIoKTtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKGlkZW50aWZpZXIpO1xuICB0aGlzLnBlbmRpbmdPcHMgPSB7XG4gICAgb3BlcmF0aW9uczogeyAuLi5wZW5kaW5nIH0sXG4gICAgaWRlbnRpZmllcixcbiAgfTtcblxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICAvLyBCZWZvcmUgY2FsbGluZyB0aGUgdHJpZ2dlciwgdmFsaWRhdGUgdGhlIHBlcm1pc3Npb25zIGZvciB0aGUgc2F2ZSBvcGVyYXRpb25cbiAgICAgIGxldCBkYXRhYmFzZVByb21pc2UgPSBudWxsO1xuICAgICAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICAgICAgLy8gVmFsaWRhdGUgZm9yIHVwZGF0aW5nXG4gICAgICAgIGRhdGFiYXNlUHJvbWlzZSA9IHRoaXMuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZShcbiAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICB0aGlzLnF1ZXJ5LFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgY3JlYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UuY3JlYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgdHJ1ZVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gSW4gdGhlIGNhc2UgdGhhdCB0aGVyZSBpcyBubyBwZXJtaXNzaW9uIGZvciB0aGUgb3BlcmF0aW9uLCBpdCB0aHJvd3MgYW4gZXJyb3JcbiAgICAgIHJldHVybiBkYXRhYmFzZVByb21pc2UudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICBpZiAoIXJlc3VsdCB8fCByZXN1bHQubGVuZ3RoIDw9IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQuJyk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyaWdnZXJzLm1heWJlUnVuVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgICAgdGhpcy5hdXRoLFxuICAgICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgdGhpcy5jb25maWcsXG4gICAgICAgIHRoaXMuY29udGV4dFxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSBfLnJlZHVjZShcbiAgICAgICAgICByZXNwb25zZS5vYmplY3QsXG4gICAgICAgICAgKHJlc3VsdCwgdmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRXF1YWwodGhpcy5kYXRhW2tleV0sIHZhbHVlKSkge1xuICAgICAgICAgICAgICByZXN1bHQucHVzaChrZXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICB9LFxuICAgICAgICAgIFtdXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGF0YSA9IHJlc3BvbnNlLm9iamVjdDtcbiAgICAgICAgLy8gV2Ugc2hvdWxkIGRlbGV0ZSB0aGUgb2JqZWN0SWQgZm9yIGFuIHVwZGF0ZSB3cml0ZVxuICAgICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgVXRpbHMuY2hlY2tQcm9oaWJpdGVkS2V5d29yZHModGhpcy5jb25maWcsIHRoaXMuZGF0YSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgZXJyb3IpO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5CZWZvcmVMb2dpblRyaWdnZXIgPSBhc3luYyBmdW5jdGlvbiAodXNlckRhdGEpIHtcbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYmVmb3JlTG9naW4nIHRyaWdnZXJcbiAgaWYgKFxuICAgICF0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKHRoaXMuY2xhc3NOYW1lLCB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVMb2dpbiwgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZClcbiAgKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQ2xvdWQgY29kZSBnZXRzIGEgYml0IG9mIGV4dHJhIGRhdGEgZm9yIGl0cyBvYmplY3RzXG4gIGNvbnN0IGV4dHJhRGF0YSA9IHsgY2xhc3NOYW1lOiB0aGlzLmNsYXNzTmFtZSB9O1xuXG4gIC8vIEV4cGFuZCBmaWxlIG9iamVjdHNcbiAgYXdhaXQgdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QodGhpcy5jb25maWcsIHVzZXJEYXRhKTtcblxuICBjb25zdCB1c2VyID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHVzZXJEYXRhKTtcblxuICAvLyBubyBuZWVkIHRvIHJldHVybiBhIHJlc3BvbnNlXG4gIGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuVHJpZ2dlcihcbiAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVMb2dpbixcbiAgICB0aGlzLmF1dGgsXG4gICAgdXNlcixcbiAgICBudWxsLFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuY29udGV4dFxuICApO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5zZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5kYXRhKSB7XG4gICAgcmV0dXJuIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyLmdldEFsbENsYXNzZXMoKS50aGVuKGFsbENsYXNzZXMgPT4ge1xuICAgICAgY29uc3Qgc2NoZW1hID0gYWxsQ2xhc3Nlcy5maW5kKG9uZUNsYXNzID0+IG9uZUNsYXNzLmNsYXNzTmFtZSA9PT0gdGhpcy5jbGFzc05hbWUpO1xuICAgICAgY29uc3Qgc2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkID0gKGZpZWxkTmFtZSwgc2V0RGVmYXVsdCkgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IHVuZGVmaW5lZCB8fFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSBudWxsIHx8XG4gICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09ICcnIHx8XG4gICAgICAgICAgKHR5cGVvZiB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gJ29iamVjdCcgJiYgdGhpcy5kYXRhW2ZpZWxkTmFtZV0uX19vcCA9PT0gJ0RlbGV0ZScpXG4gICAgICAgICkge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHNldERlZmF1bHQgJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZSAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZSAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICAgICAodGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IHVuZGVmaW5lZCB8fFxuICAgICAgICAgICAgICAodHlwZW9mIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnb2JqZWN0JyAmJiB0aGlzLmRhdGFbZmllbGROYW1lXS5fX29wID09PSAnRGVsZXRlJykpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5kZWZhdWx0VmFsdWU7XG4gICAgICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciA9IHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIHx8IFtdO1xuICAgICAgICAgICAgaWYgKHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLmluZGV4T2YoZmllbGROYW1lKSA8IDApIHtcbiAgICAgICAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5yZXF1aXJlZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIGAke2ZpZWxkTmFtZX0gaXMgcmVxdWlyZWRgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIC8vIGFkZCBkZWZhdWx0IEFDTFxuICAgICAgaWYgKFxuICAgICAgICBzY2hlbWE/LmNsYXNzTGV2ZWxQZXJtaXNzaW9ucz8uQUNMICYmXG4gICAgICAgICF0aGlzLmRhdGEuQUNMICYmXG4gICAgICAgIEpTT04uc3RyaW5naWZ5KHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMuQUNMKSAhPT1cbiAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7ICcqJzogeyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9IH0pXG4gICAgICApIHtcbiAgICAgICAgY29uc3QgYWNsID0gZGVlcGNvcHkoc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucy5BQ0wpO1xuICAgICAgICBpZiAoYWNsLmN1cnJlbnRVc2VyKSB7XG4gICAgICAgICAgaWYgKHRoaXMuYXV0aC51c2VyPy5pZCkge1xuICAgICAgICAgICAgYWNsW3RoaXMuYXV0aC51c2VyPy5pZF0gPSBkZWVwY29weShhY2wuY3VycmVudFVzZXIpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBkZWxldGUgYWNsLmN1cnJlbnRVc2VyO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuZGF0YS5BQ0wgPSBhY2w7XG4gICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyID0gdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgfHwgW107XG4gICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLnB1c2goJ0FDTCcpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBhc3NpZ25PYmplY3RJZCA9ICgpID0+IHtcbiAgICAgICAgY29uc3Qgb2JqZWN0SWQgPSBjcnlwdG9VdGlscy5uZXdPYmplY3RJZChcbiAgICAgICAgICB0aGlzLmNvbmZpZy5vYmplY3RJZFNpemUsXG4gICAgICAgICAgdGhpcy5jb25maWcub2JqZWN0SWRVc2VUaW1lXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCF0aGlzLmNvbmZpZy5vYmplY3RJZFByZWZpeGVzKSB7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdElkO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5vYmplY3RJZFByZWZpeGVzW3RoaXMuY2xhc3NOYW1lXVxuICAgICAgICAgID8gYCR7dGhpcy5jb25maWcub2JqZWN0SWRQcmVmaXhlc1t0aGlzLmNsYXNzTmFtZV19JHtvYmplY3RJZH1gXG4gICAgICAgICAgOiBvYmplY3RJZDtcbiAgICAgIH07XG5cbiAgICAgIC8vIEFkZCBkZWZhdWx0IGZpZWxkc1xuICAgICAgaWYgKCF0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIC8vIGFsbG93IGN1c3RvbWl6aW5nIGNyZWF0ZWRBdCBhbmQgdXBkYXRlZEF0IHdoZW4gdXNpbmcgbWFpbnRlbmFuY2Uga2V5XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0Ll9fdHlwZSA9PT0gJ0RhdGUnXG4gICAgICAgICkge1xuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0LmlzbztcblxuICAgICAgICAgIGlmICh0aGlzLmRhdGEudXBkYXRlZEF0ICYmIHRoaXMuZGF0YS51cGRhdGVkQXQuX190eXBlID09PSAnRGF0ZScpIHtcbiAgICAgICAgICAgIGNvbnN0IGNyZWF0ZWRBdCA9IG5ldyBEYXRlKHRoaXMuZGF0YS5jcmVhdGVkQXQpO1xuICAgICAgICAgICAgY29uc3QgdXBkYXRlZEF0ID0gbmV3IERhdGUodGhpcy5kYXRhLnVwZGF0ZWRBdC5pc28pO1xuXG4gICAgICAgICAgICBpZiAodXBkYXRlZEF0IDwgY3JlYXRlZEF0KSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgICd1cGRhdGVkQXQgY2Fubm90IG9jY3VyIGJlZm9yZSBjcmVhdGVkQXQnXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLmRhdGEudXBkYXRlZEF0LmlzbztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gaWYgbm8gdXBkYXRlZEF0IGlzIHByb3ZpZGVkLCBzZXQgaXQgdG8gY3JlYXRlZEF0IHRvIG1hdGNoIGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gT25seSBhc3NpZ24gbmV3IG9iamVjdElkIGlmIHdlIGFyZSBjcmVhdGluZyBuZXcgb2JqZWN0XG4gICAgICAgIGlmICghdGhpcy5kYXRhLm9iamVjdElkKSB7XG4gICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gYXNzaWduT2JqZWN0SWQoKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2NoZW1hKSB7XG4gICAgICAgICAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgc2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkKGZpZWxkTmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcblxuICAgICAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQoZmllbGROYW1lLCBmYWxzZSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cbi8vIFRyYW5zZm9ybXMgYXV0aCBkYXRhIGZvciBhIHVzZXIgb2JqZWN0LlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYSB1c2VyIG9iamVjdC5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVBdXRoRGF0YSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYXV0aERhdGEgPSB0aGlzLmRhdGEuYXV0aERhdGE7XG4gIGNvbnN0IGhhc1VzZXJuYW1lQW5kUGFzc3dvcmQgPVxuICAgIHR5cGVvZiB0aGlzLmRhdGEudXNlcm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiB0aGlzLmRhdGEucGFzc3dvcmQgPT09ICdzdHJpbmcnO1xuXG4gIGlmICghdGhpcy5xdWVyeSAmJiAhYXV0aERhdGEpIHtcbiAgICBpZiAodHlwZW9mIHRoaXMuZGF0YS51c2VybmFtZSAhPT0gJ3N0cmluZycgfHwgXy5pc0VtcHR5KHRoaXMuZGF0YS51c2VybmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5VU0VSTkFNRV9NSVNTSU5HLCAnYmFkIG9yIG1pc3NpbmcgdXNlcm5hbWUnKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB0aGlzLmRhdGEucGFzc3dvcmQgIT09ICdzdHJpbmcnIHx8IF8uaXNFbXB0eSh0aGlzLmRhdGEucGFzc3dvcmQpKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuUEFTU1dPUkRfTUlTU0lORywgJ3Bhc3N3b3JkIGlzIHJlcXVpcmVkJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKFxuICAgIChhdXRoRGF0YSAmJiAhT2JqZWN0LmtleXMoYXV0aERhdGEpLmxlbmd0aCkgfHxcbiAgICAhT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHRoaXMuZGF0YSwgJ2F1dGhEYXRhJylcbiAgKSB7XG4gICAgLy8gTm90aGluZyB0byB2YWxpZGF0ZSBoZXJlXG4gICAgcmV0dXJuO1xuICB9IGVsc2UgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh0aGlzLmRhdGEsICdhdXRoRGF0YScpICYmICF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICAvLyBIYW5kbGUgc2F2aW5nIGF1dGhEYXRhIHRvIG51bGxcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLidcbiAgICApO1xuICB9XG5cbiAgdmFyIHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgaWYgKHByb3ZpZGVycy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY2FuSGFuZGxlQXV0aERhdGEgPSBwcm92aWRlcnMuc29tZShwcm92aWRlciA9PiB7XG4gICAgICBjb25zdCBwcm92aWRlckF1dGhEYXRhID0gYXV0aERhdGFbcHJvdmlkZXJdIHx8IHt9O1xuICAgICAgcmV0dXJuICEhT2JqZWN0LmtleXMocHJvdmlkZXJBdXRoRGF0YSkubGVuZ3RoO1xuICAgIH0pO1xuICAgIGlmIChjYW5IYW5kbGVBdXRoRGF0YSB8fCBoYXNVc2VybmFtZUFuZFBhc3N3b3JkIHx8IHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmdldFVzZXJJZCgpKSB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoRGF0YShhdXRoRGF0YSk7XG4gICAgfVxuICB9XG4gIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbHRlcmVkT2JqZWN0c0J5QUNMID0gZnVuY3Rpb24gKG9iamVjdHMpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybiBvYmplY3RzO1xuICB9XG4gIHJldHVybiBvYmplY3RzLmZpbHRlcihvYmplY3QgPT4ge1xuICAgIGlmICghb2JqZWN0LkFDTCkge1xuICAgICAgcmV0dXJuIHRydWU7IC8vIGxlZ2FjeSB1c2VycyB0aGF0IGhhdmUgbm8gQUNMIGZpZWxkIG9uIHRoZW1cbiAgICB9XG4gICAgLy8gUmVndWxhciB1c2VycyB0aGF0IGhhdmUgYmVlbiBsb2NrZWQgb3V0LlxuICAgIHJldHVybiBvYmplY3QuQUNMICYmIE9iamVjdC5rZXlzKG9iamVjdC5BQ0wpLmxlbmd0aCA+IDA7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VySWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gdGhpcy5xdWVyeS5vYmplY3RJZDtcbiAgfSBlbHNlIGlmICh0aGlzLmF1dGggJiYgdGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLnVzZXIuaWQ7XG4gIH1cbn07XG5cbi8vIERldmVsb3BlcnMgYXJlIGFsbG93ZWQgdG8gY2hhbmdlIGF1dGhEYXRhIHZpYSBiZWZvcmUgc2F2ZSB0cmlnZ2VyXG4vLyB3ZSBuZWVkIGFmdGVyIGJlZm9yZSBzYXZlIHRvIGVuc3VyZSB0aGF0IHRoZSBkZXZlbG9wZXJcbi8vIGlzIG5vdCBjdXJyZW50bHkgZHVwbGljYXRpbmcgYXV0aCBkYXRhIElEXG5SZXN0V3JpdGUucHJvdG90eXBlLmVuc3VyZVVuaXF1ZUF1dGhEYXRhSWQgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaGFzQXV0aERhdGFJZCA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkuc29tZShcbiAgICBrZXkgPT4gdGhpcy5kYXRhLmF1dGhEYXRhW2tleV0gJiYgdGhpcy5kYXRhLmF1dGhEYXRhW2tleV0uaWRcbiAgKTtcblxuICBpZiAoIWhhc0F1dGhEYXRhSWQpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCByID0gYXdhaXQgQXV0aC5maW5kVXNlcnNXaXRoQXV0aERhdGEodGhpcy5jb25maWcsIHRoaXMuZGF0YS5hdXRoRGF0YSk7XG4gIGNvbnN0IHJlc3VsdHMgPSB0aGlzLmZpbHRlcmVkT2JqZWN0c0J5QUNMKHIpO1xuICBpZiAocmVzdWx0cy5sZW5ndGggPiAxKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsICd0aGlzIGF1dGggaXMgYWxyZWFkeSB1c2VkJyk7XG4gIH1cbiAgLy8gdXNlIGRhdGEub2JqZWN0SWQgaW4gY2FzZSBvZiBsb2dpbiB0aW1lIGFuZCBmb3VuZCB1c2VyIGR1cmluZyBoYW5kbGUgdmFsaWRhdGVBdXRoRGF0YVxuICBjb25zdCB1c2VySWQgPSB0aGlzLmdldFVzZXJJZCgpIHx8IHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgaWYgKHJlc3VsdHMubGVuZ3RoID09PSAxICYmIHVzZXJJZCAhPT0gcmVzdWx0c1swXS5vYmplY3RJZCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUF1dGhEYXRhID0gYXN5bmMgZnVuY3Rpb24gKGF1dGhEYXRhKSB7XG4gIGNvbnN0IHIgPSBhd2FpdCBBdXRoLmZpbmRVc2Vyc1dpdGhBdXRoRGF0YSh0aGlzLmNvbmZpZywgYXV0aERhdGEsIHRydWUpO1xuICBjb25zdCByZXN1bHRzID0gdGhpcy5maWx0ZXJlZE9iamVjdHNCeUFDTChyKTtcblxuICBjb25zdCB1c2VySWQgPSB0aGlzLmdldFVzZXJJZCgpO1xuICBjb25zdCB1c2VyUmVzdWx0ID0gcmVzdWx0c1swXTtcbiAgY29uc3QgZm91bmRVc2VySXNOb3RDdXJyZW50VXNlciA9IHVzZXJJZCAmJiB1c2VyUmVzdWx0ICYmIHVzZXJJZCAhPT0gdXNlclJlc3VsdC5vYmplY3RJZDtcblxuICBpZiAocmVzdWx0cy5sZW5ndGggPiAxIHx8IGZvdW5kVXNlcklzTm90Q3VycmVudFVzZXIpIHtcbiAgICAvLyBUbyBhdm9pZCBodHRwczovL2dpdGh1Yi5jb20vcGFyc2UtY29tbXVuaXR5L3BhcnNlLXNlcnZlci9zZWN1cml0eS9hZHZpc29yaWVzL0dIU0EtOHczai1nOTgzLThqaDVcbiAgICAvLyBMZXQncyBydW4gc29tZSB2YWxpZGF0aW9uIGJlZm9yZSB0aHJvd2luZ1xuICAgIGF3YWl0IEF1dGguaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKGF1dGhEYXRhLCB0aGlzLCB1c2VyUmVzdWx0KTtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuQUNDT1VOVF9BTFJFQURZX0xJTktFRCwgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnKTtcbiAgfVxuXG4gIC8vIE5vIHVzZXIgZm91bmQgd2l0aCBwcm92aWRlZCBhdXRoRGF0YSB3ZSBuZWVkIHRvIHZhbGlkYXRlXG4gIGlmICghcmVzdWx0cy5sZW5ndGgpIHtcbiAgICBjb25zdCB7IGF1dGhEYXRhOiB2YWxpZGF0ZWRBdXRoRGF0YSwgYXV0aERhdGFSZXNwb25zZSB9ID0gYXdhaXQgQXV0aC5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24oXG4gICAgICBhdXRoRGF0YSxcbiAgICAgIHRoaXNcbiAgICApO1xuICAgIHRoaXMuYXV0aERhdGFSZXNwb25zZSA9IGF1dGhEYXRhUmVzcG9uc2U7XG4gICAgLy8gUmVwbGFjZSBjdXJyZW50IGF1dGhEYXRhIGJ5IHRoZSBuZXcgdmFsaWRhdGVkIG9uZVxuICAgIHRoaXMuZGF0YS5hdXRoRGF0YSA9IHZhbGlkYXRlZEF1dGhEYXRhO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFVzZXIgZm91bmQgd2l0aCBwcm92aWRlZCBhdXRoRGF0YVxuICBpZiAocmVzdWx0cy5sZW5ndGggPT09IDEpIHtcbiAgICB0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyID0gT2JqZWN0LmtleXMoYXV0aERhdGEpLmpvaW4oJywnKTtcblxuICAgIGNvbnN0IHsgaGFzTXV0YXRlZEF1dGhEYXRhLCBtdXRhdGVkQXV0aERhdGEgfSA9IEF1dGguaGFzTXV0YXRlZEF1dGhEYXRhKFxuICAgICAgYXV0aERhdGEsXG4gICAgICB1c2VyUmVzdWx0LmF1dGhEYXRhXG4gICAgKTtcblxuICAgIGNvbnN0IGlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3RlciA9XG4gICAgICAodGhpcy5hdXRoICYmIHRoaXMuYXV0aC51c2VyICYmIHRoaXMuYXV0aC51c2VyLmlkID09PSB1c2VyUmVzdWx0Lm9iamVjdElkKSB8fFxuICAgICAgdGhpcy5hdXRoLmlzTWFzdGVyO1xuXG4gICAgY29uc3QgaXNMb2dpbiA9ICF1c2VySWQ7XG5cbiAgICBpZiAoaXNMb2dpbiB8fCBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIpIHtcbiAgICAgIC8vIG5vIHVzZXIgbWFraW5nIHRoZSBjYWxsXG4gICAgICAvLyBPUiB0aGUgdXNlciBtYWtpbmcgdGhlIGNhbGwgaXMgdGhlIHJpZ2h0IG9uZVxuICAgICAgLy8gTG9naW4gd2l0aCBhdXRoIGRhdGFcbiAgICAgIGRlbGV0ZSByZXN1bHRzWzBdLnBhc3N3b3JkO1xuXG4gICAgICAvLyBuZWVkIHRvIHNldCB0aGUgb2JqZWN0SWQgZmlyc3Qgb3RoZXJ3aXNlIGxvY2F0aW9uIGhhcyB0cmFpbGluZyB1bmRlZmluZWRcbiAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCA9IHVzZXJSZXN1bHQub2JqZWN0SWQ7XG5cbiAgICAgIGlmICghdGhpcy5xdWVyeSB8fCAhdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgIHJlc3BvbnNlOiB1c2VyUmVzdWx0LFxuICAgICAgICAgIGxvY2F0aW9uOiB0aGlzLmxvY2F0aW9uKCksXG4gICAgICAgIH07XG4gICAgICAgIC8vIFJ1biBiZWZvcmVMb2dpbiBob29rIGJlZm9yZSBzdG9yaW5nIGFueSB1cGRhdGVzXG4gICAgICAgIC8vIHRvIGF1dGhEYXRhIG9uIHRoZSBkYjsgY2hhbmdlcyB0byB1c2VyUmVzdWx0XG4gICAgICAgIC8vIHdpbGwgYmUgaWdub3JlZC5cbiAgICAgICAgYXdhaXQgdGhpcy5ydW5CZWZvcmVMb2dpblRyaWdnZXIoZGVlcGNvcHkodXNlclJlc3VsdCkpO1xuXG4gICAgICAgIC8vIElmIHdlIGFyZSBpbiBsb2dpbiBvcGVyYXRpb24gdmlhIGF1dGhEYXRhXG4gICAgICAgIC8vIHdlIG5lZWQgdG8gYmUgc3VyZSB0aGF0IHRoZSB1c2VyIGhhcyBwcm92aWRlZFxuICAgICAgICAvLyByZXF1aXJlZCBhdXRoRGF0YVxuICAgICAgICBBdXRoLmNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4oXG4gICAgICAgICAgeyBjb25maWc6IHRoaXMuY29uZmlnLCBhdXRoOiB0aGlzLmF1dGggfSxcbiAgICAgICAgICBhdXRoRGF0YSxcbiAgICAgICAgICB1c2VyUmVzdWx0LmF1dGhEYXRhLFxuICAgICAgICAgIHRoaXMuY29uZmlnXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIC8vIFByZXZlbnQgdmFsaWRhdGluZyBpZiBubyBtdXRhdGVkIGRhdGEgZGV0ZWN0ZWQgb24gdXBkYXRlXG4gICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSAmJiBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBGb3JjZSB0byB2YWxpZGF0ZSBhbGwgcHJvdmlkZWQgYXV0aERhdGEgb24gbG9naW5cbiAgICAgIC8vIG9uIHVwZGF0ZSBvbmx5IHZhbGlkYXRlIG11dGF0ZWQgb25lc1xuICAgICAgaWYgKGhhc011dGF0ZWRBdXRoRGF0YSB8fCAhdGhpcy5jb25maWcuYWxsb3dFeHBpcmVkQXV0aERhdGFUb2tlbikge1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihcbiAgICAgICAgICBpc0xvZ2luID8gYXV0aERhdGEgOiBtdXRhdGVkQXV0aERhdGEsXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICB1c2VyUmVzdWx0XG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGF0YS5hdXRoRGF0YSA9IHJlcy5hdXRoRGF0YTtcbiAgICAgICAgdGhpcy5hdXRoRGF0YVJlc3BvbnNlID0gcmVzLmF1dGhEYXRhUmVzcG9uc2U7XG4gICAgICB9XG5cbiAgICAgIC8vIElGIHdlIGFyZSBpbiBsb2dpbiB3ZSdsbCBza2lwIHRoZSBkYXRhYmFzZSBvcGVyYXRpb24gLyBiZWZvcmVTYXZlIC8gYWZ0ZXJTYXZlIGV0Yy4uLlxuICAgICAgLy8gd2UgbmVlZCB0byBzZXQgaXQgdXAgdGhlcmUuXG4gICAgICAvLyBXZSBhcmUgc3VwcG9zZWQgdG8gaGF2ZSBhIHJlc3BvbnNlIG9ubHkgb24gTE9HSU4gd2l0aCBhdXRoRGF0YSwgc28gd2Ugc2tpcCB0aG9zZVxuICAgICAgLy8gSWYgd2UncmUgbm90IGxvZ2dpbmcgaW4sIGJ1dCBqdXN0IHVwZGF0aW5nIHRoZSBjdXJyZW50IHVzZXIsIHdlIGNhbiBzYWZlbHkgc2tpcCB0aGF0IHBhcnRcbiAgICAgIGlmICh0aGlzLnJlc3BvbnNlKSB7XG4gICAgICAgIC8vIEFzc2lnbiB0aGUgbmV3IGF1dGhEYXRhIGluIHRoZSByZXNwb25zZVxuICAgICAgICBPYmplY3Qua2V5cyhtdXRhdGVkQXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UuYXV0aERhdGFbcHJvdmlkZXJdID0gbXV0YXRlZEF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gUnVuIHRoZSBEQiB1cGRhdGUgZGlyZWN0bHksIGFzICdtYXN0ZXInIG9ubHkgaWYgYXV0aERhdGEgY29udGFpbnMgc29tZSBrZXlzXG4gICAgICAgIC8vIGF1dGhEYXRhIGNvdWxkIG5vdCBjb250YWlucyBrZXlzIGFmdGVyIHZhbGlkYXRpb24gaWYgdGhlIGF1dGhBZGFwdGVyXG4gICAgICAgIC8vIHVzZXMgdGhlIGBkb05vdFNhdmVgIG9wdGlvbi4gSnVzdCB1cGRhdGUgdGhlIGF1dGhEYXRhIHBhcnRcbiAgICAgICAgLy8gVGhlbiB3ZSdyZSBnb29kIGZvciB0aGUgdXNlciwgZWFybHkgZXhpdCBvZiBzb3J0c1xuICAgICAgICBpZiAoT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGgpIHtcbiAgICAgICAgICBhd2FpdCB0aGlzLmNvbmZpZy5kYXRhYmFzZS51cGRhdGUoXG4gICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMuZGF0YS5vYmplY3RJZCB9LFxuICAgICAgICAgICAgeyBhdXRoRGF0YTogdGhpcy5kYXRhLmF1dGhEYXRhIH0sXG4gICAgICAgICAgICB7fVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY2hlY2tSZXN0cmljdGVkRmllbGRzID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgJ2VtYWlsVmVyaWZpZWQnIGluIHRoaXMuZGF0YSkge1xuICAgIGNvbnN0IGVycm9yID0gYENsaWVudHMgYXJlbid0IGFsbG93ZWQgdG8gbWFudWFsbHkgdXBkYXRlIGVtYWlsIHZlcmlmaWNhdGlvbi5gO1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLCBlcnJvcik7XG4gIH1cbn07XG5cbi8vIFRoZSBub24tdGhpcmQtcGFydHkgcGFydHMgb2YgVXNlciB0cmFuc2Zvcm1hdGlvblxuUmVzdFdyaXRlLnByb3RvdHlwZS50cmFuc2Zvcm1Vc2VyID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIC8vIERvIG5vdCBjbGVhbnVwIHNlc3Npb24gaWYgb2JqZWN0SWQgaXMgbm90IHNldFxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLm9iamVjdElkKCkpIHtcbiAgICAvLyBJZiB3ZSdyZSB1cGRhdGluZyBhIF9Vc2VyIG9iamVjdCwgd2UgbmVlZCB0byBjbGVhciBvdXQgdGhlIGNhY2hlIGZvciB0aGF0IHVzZXIuIEZpbmQgYWxsIHRoZWlyXG4gICAgLy8gc2Vzc2lvbiB0b2tlbnMsIGFuZCByZW1vdmUgdGhlbSBmcm9tIHRoZSBjYWNoZS5cbiAgICBjb25zdCBxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZmluZCxcbiAgICAgIGNvbmZpZzogdGhpcy5jb25maWcsXG4gICAgICBhdXRoOiBBdXRoLm1hc3Rlcih0aGlzLmNvbmZpZyksXG4gICAgICBjbGFzc05hbWU6ICdfU2Vzc2lvbicsXG4gICAgICBydW5CZWZvcmVGaW5kOiBmYWxzZSxcbiAgICAgIHJlc3RXaGVyZToge1xuICAgICAgICB1c2VyOiB7XG4gICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHByb21pc2UgPSBxdWVyeS5leGVjdXRlKCkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMucmVzdWx0cy5mb3JFYWNoKHNlc3Npb24gPT5cbiAgICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnVzZXIuZGVsKHNlc3Npb24uc2Vzc2lvblRva2VuKVxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBwcm9taXNlXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gVHJhbnNmb3JtIHRoZSBwYXNzd29yZFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIC8vIGlnbm9yZSBvbmx5IGlmIHVuZGVmaW5lZC4gc2hvdWxkIHByb2NlZWQgaWYgZW1wdHkgKCcnKVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddID0gdHJ1ZTtcbiAgICAgICAgLy8gR2VuZXJhdGUgYSBuZXcgc2Vzc2lvbiBvbmx5IGlmIHRoZSB1c2VyIHJlcXVlc3RlZFxuICAgICAgICBpZiAoIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICAgICAgICB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uaGFzaCh0aGlzLmRhdGEucGFzc3dvcmQpLnRoZW4oaGFzaGVkUGFzc3dvcmQgPT4ge1xuICAgICAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkID0gaGFzaGVkUGFzc3dvcmQ7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVVzZXJOYW1lKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVFbWFpbCgpO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVVc2VyTmFtZSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gQ2hlY2sgZm9yIHVzZXJuYW1lIHVuaXF1ZW5lc3NcbiAgaWYgKCF0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgIHRoaXMuZGF0YS51c2VybmFtZSA9IGNyeXB0b1V0aWxzLnJhbmRvbVN0cmluZygyNSk7XG4gICAgICB0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8qXG4gICAgVXNlcm5hbWVzIHNob3VsZCBiZSB1bmlxdWUgd2hlbiBjb21wYXJlZCBjYXNlIGluc2Vuc2l0aXZlbHlcblxuICAgIFVzZXJzIHNob3VsZCBiZSBhYmxlIHRvIG1ha2UgY2FzZSBzZW5zaXRpdmUgdXNlcm5hbWVzIGFuZFxuICAgIGxvZ2luIHVzaW5nIHRoZSBjYXNlIHRoZXkgZW50ZXJlZC4gIEkuZS4gJ1Nub29weScgc2hvdWxkIHByZWNsdWRlXG4gICAgJ3Nub29weScgYXMgYSB2YWxpZCB1c2VybmFtZS5cbiAgKi9cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHtcbiAgICAgICAgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSxcbiAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgIH0sXG4gICAgICB7IGxpbWl0OiAxLCBjYXNlSW5zZW5zaXRpdmU6IHRydWUgfSxcbiAgICAgIHt9LFxuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfSk7XG59O1xuXG4vKlxuICBBcyB3aXRoIHVzZXJuYW1lcywgUGFyc2Ugc2hvdWxkIG5vdCBhbGxvdyBjYXNlIGluc2Vuc2l0aXZlIGNvbGxpc2lvbnMgb2YgZW1haWwuXG4gIHVubGlrZSB3aXRoIHVzZXJuYW1lcyAod2hpY2ggY2FuIGhhdmUgY2FzZSBpbnNlbnNpdGl2ZSBjb2xsaXNpb25zIGluIHRoZSBjYXNlIG9mXG4gIGF1dGggYWRhcHRlcnMpLCBlbWFpbHMgc2hvdWxkIG5ldmVyIGhhdmUgYSBjYXNlIGluc2Vuc2l0aXZlIGNvbGxpc2lvbi5cblxuICBUaGlzIGJlaGF2aW9yIGNhbiBiZSBlbmZvcmNlZCB0aHJvdWdoIGEgcHJvcGVybHkgY29uZmlndXJlZCBpbmRleCBzZWU6XG4gIGh0dHBzOi8vZG9jcy5tb25nb2RiLmNvbS9tYW51YWwvY29yZS9pbmRleC1jYXNlLWluc2Vuc2l0aXZlLyNjcmVhdGUtYS1jYXNlLWluc2Vuc2l0aXZlLWluZGV4XG4gIHdoaWNoIGNvdWxkIGJlIGltcGxlbWVudGVkIGluc3RlYWQgb2YgdGhpcyBjb2RlIGJhc2VkIHZhbGlkYXRpb24uXG5cbiAgR2l2ZW4gdGhhdCB0aGlzIGxvb2t1cCBzaG91bGQgYmUgYSByZWxhdGl2ZWx5IGxvdyB1c2UgY2FzZSBhbmQgdGhhdCB0aGUgY2FzZSBzZW5zaXRpdmVcbiAgdW5pcXVlIGluZGV4IHdpbGwgYmUgdXNlZCBieSB0aGUgZGIgZm9yIHRoZSBxdWVyeSwgdGhpcyBpcyBhbiBhZGVxdWF0ZSBzb2x1dGlvbi5cbiovXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZUVtYWlsID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuZGF0YS5lbWFpbCB8fCB0aGlzLmRhdGEuZW1haWwuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gVmFsaWRhdGUgYmFzaWMgZW1haWwgYWRkcmVzcyBmb3JtYXRcbiAgaWYgKCF0aGlzLmRhdGEuZW1haWwubWF0Y2goL14uK0AuKyQvKSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0VNQUlMX0FERFJFU1MsICdFbWFpbCBhZGRyZXNzIGZvcm1hdCBpcyBpbnZhbGlkLicpXG4gICAgKTtcbiAgfVxuICAvLyBDYXNlIGluc2Vuc2l0aXZlIG1hdGNoLCBzZWUgbm90ZSBhYm92ZSBmdW5jdGlvbi5cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHtcbiAgICAgICAgZW1haWw6IHRoaXMuZGF0YS5lbWFpbCxcbiAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgIH0sXG4gICAgICB7IGxpbWl0OiAxLCBjYXNlSW5zZW5zaXRpdmU6IHRydWUgfSxcbiAgICAgIHt9LFxuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgIXRoaXMuZGF0YS5hdXRoRGF0YSB8fFxuICAgICAgICAhT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGggfHxcbiAgICAgICAgKE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoID09PSAxICYmXG4gICAgICAgICAgT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKVswXSA9PT0gJ2Fub255bW91cycpXG4gICAgICApIHtcbiAgICAgICAgLy8gV2UgdXBkYXRlZCB0aGUgZW1haWwsIHNlbmQgYSBuZXcgdmFsaWRhdGlvblxuICAgICAgICBjb25zdCB7IG9yaWdpbmFsT2JqZWN0LCB1cGRhdGVkT2JqZWN0IH0gPSB0aGlzLmJ1aWxkUGFyc2VPYmplY3RzKCk7XG4gICAgICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICAgICAgb3JpZ2luYWw6IG9yaWdpbmFsT2JqZWN0LFxuICAgICAgICAgIG9iamVjdDogdXBkYXRlZE9iamVjdCxcbiAgICAgICAgICBtYXN0ZXI6IHRoaXMuYXV0aC5pc01hc3RlcixcbiAgICAgICAgICBpcDogdGhpcy5jb25maWcuaXAsXG4gICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgfTtcbiAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNldEVtYWlsVmVyaWZ5VG9rZW4odGhpcy5kYXRhLCByZXF1ZXN0LCB0aGlzLnN0b3JhZ2UpO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cygpLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSgpO1xuICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIGNoZWNrIGlmIHRoZSBwYXNzd29yZCBjb25mb3JtcyB0byB0aGUgZGVmaW5lZCBwYXNzd29yZCBwb2xpY3kgaWYgY29uZmlndXJlZFxuICAvLyBJZiB3ZSBzcGVjaWZpZWQgYSBjdXN0b20gZXJyb3IgaW4gb3VyIGNvbmZpZ3VyYXRpb24gdXNlIGl0LlxuICAvLyBFeGFtcGxlOiBcIlBhc3N3b3JkcyBtdXN0IGluY2x1ZGUgYSBDYXBpdGFsIExldHRlciwgTG93ZXJjYXNlIExldHRlciwgYW5kIGEgbnVtYmVyLlwiXG4gIC8vXG4gIC8vIFRoaXMgaXMgZXNwZWNpYWxseSB1c2VmdWwgb24gdGhlIGdlbmVyaWMgXCJwYXNzd29yZCByZXNldFwiIHBhZ2UsXG4gIC8vIGFzIGl0IGFsbG93cyB0aGUgcHJvZ3JhbW1lciB0byBjb21tdW5pY2F0ZSBzcGVjaWZpYyByZXF1aXJlbWVudHMgaW5zdGVhZCBvZjpcbiAgLy8gYS4gbWFraW5nIHRoZSB1c2VyIGd1ZXNzIHdoYXRzIHdyb25nXG4gIC8vIGIuIG1ha2luZyBhIGN1c3RvbSBwYXNzd29yZCByZXNldCBwYWdlIHRoYXQgc2hvd3MgdGhlIHJlcXVpcmVtZW50c1xuICBjb25zdCBwb2xpY3lFcnJvciA9IHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRpb25FcnJvclxuICAgID8gdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdGlvbkVycm9yXG4gICAgOiAnUGFzc3dvcmQgZG9lcyBub3QgbWVldCB0aGUgUGFzc3dvcmQgUG9saWN5IHJlcXVpcmVtZW50cy4nO1xuICBjb25zdCBjb250YWluc1VzZXJuYW1lRXJyb3IgPSAnUGFzc3dvcmQgY2Fubm90IGNvbnRhaW4geW91ciB1c2VybmFtZS4nO1xuXG4gIC8vIGNoZWNrIHdoZXRoZXIgdGhlIHBhc3N3b3JkIG1lZXRzIHRoZSBwYXNzd29yZCBzdHJlbmd0aCByZXF1aXJlbWVudHNcbiAgaWYgKFxuICAgICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yICYmXG4gICAgICAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kucGF0dGVyblZhbGlkYXRvcih0aGlzLmRhdGEucGFzc3dvcmQpKSB8fFxuICAgICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayAmJlxuICAgICAgIXRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRvckNhbGxiYWNrKHRoaXMuZGF0YS5wYXNzd29yZCkpXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUiwgcG9saWN5RXJyb3IpKTtcbiAgfVxuXG4gIC8vIGNoZWNrIHdoZXRoZXIgcGFzc3dvcmQgY29udGFpbiB1c2VybmFtZVxuICBpZiAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kuZG9Ob3RBbGxvd1VzZXJuYW1lID09PSB0cnVlKSB7XG4gICAgaWYgKHRoaXMuZGF0YS51c2VybmFtZSkge1xuICAgICAgLy8gdXNlcm5hbWUgaXMgbm90IHBhc3NlZCBkdXJpbmcgcGFzc3dvcmQgcmVzZXRcbiAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQuaW5kZXhPZih0aGlzLmRhdGEudXNlcm5hbWUpID49IDApIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBjb250YWluc1VzZXJuYW1lRXJyb3IpKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gcmV0cmlldmUgdGhlIFVzZXIgb2JqZWN0IHVzaW5nIG9iamVjdElkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoJ19Vc2VyJywgeyBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpIH0pLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQuaW5kZXhPZihyZXN1bHRzWzBdLnVzZXJuYW1lKSA+PSAwKSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIGNvbnRhaW5zVXNlcm5hbWVFcnJvcilcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBpcyByZXBlYXRpbmcgZnJvbSBzcGVjaWZpZWQgaGlzdG9yeVxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkpIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5maW5kKFxuICAgICAgICAnX1VzZXInLFxuICAgICAgICB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgeyBrZXlzOiBbJ19wYXNzd29yZF9oaXN0b3J5JywgJ19oYXNoZWRfcGFzc3dvcmQnXSB9LFxuICAgICAgICBBdXRoLm1haW50ZW5hbmNlKHRoaXMuY29uZmlnKVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICBsZXQgb2xkUGFzc3dvcmRzID0gW107XG4gICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KSB7XG4gICAgICAgICAgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgICAgdXNlci5fcGFzc3dvcmRfaGlzdG9yeSxcbiAgICAgICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDFcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIG9sZFBhc3N3b3Jkcy5wdXNoKHVzZXIucGFzc3dvcmQpO1xuICAgICAgICBjb25zdCBuZXdQYXNzd29yZCA9IHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgLy8gY29tcGFyZSB0aGUgbmV3IHBhc3N3b3JkIGhhc2ggd2l0aCBhbGwgb2xkIHBhc3N3b3JkIGhhc2hlc1xuICAgICAgICBjb25zdCBwcm9taXNlcyA9IG9sZFBhc3N3b3Jkcy5tYXAoZnVuY3Rpb24gKGhhc2gpIHtcbiAgICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uY29tcGFyZShuZXdQYXNzd29yZCwgaGFzaCkudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgICAvLyByZWplY3QgaWYgdGhlcmUgaXMgYSBtYXRjaFxuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoJ1JFUEVBVF9QQVNTV09SRCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgLy8gd2FpdCBmb3IgYWxsIGNvbXBhcmlzb25zIHRvIGNvbXBsZXRlXG4gICAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcylcbiAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuY2F0Y2goZXJyID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIgPT09ICdSRVBFQVRfUEFTU1dPUkQnKSB7XG4gICAgICAgICAgICAgIC8vIGEgbWF0Y2ggd2FzIGZvdW5kXG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgICAgYE5ldyBwYXNzd29yZCBzaG91bGQgbm90IGJlIHRoZSBzYW1lIGFzIGxhc3QgJHt0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3Rvcnl9IHBhc3N3b3Jkcy5gXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERvbid0IGdlbmVyYXRlIHNlc3Npb24gZm9yIHVwZGF0aW5nIHVzZXIgKHRoaXMucXVlcnkgaXMgc2V0KSB1bmxlc3MgYXV0aERhdGEgZXhpc3RzXG4gIGlmICh0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gRG9uJ3QgZ2VuZXJhdGUgbmV3IHNlc3Npb25Ub2tlbiBpZiBsaW5raW5nIHZpYSBzZXNzaW9uVG9rZW5cbiAgaWYgKHRoaXMuYXV0aC51c2VyICYmIHRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBJZiBzaWduLXVwIGNhbGxcbiAgaWYgKCF0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyKSB7XG4gICAgLy8gQ3JlYXRlIHJlcXVlc3Qgb2JqZWN0IGZvciB2ZXJpZmljYXRpb24gZnVuY3Rpb25zXG4gICAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICBvcmlnaW5hbDogb3JpZ2luYWxPYmplY3QsXG4gICAgICBvYmplY3Q6IHVwZGF0ZWRPYmplY3QsXG4gICAgICBtYXN0ZXI6IHRoaXMuYXV0aC5pc01hc3RlcixcbiAgICAgIGlwOiB0aGlzLmNvbmZpZy5pcCxcbiAgICAgIGluc3RhbGxhdGlvbklkOiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gICAgfTtcbiAgICAvLyBHZXQgdmVyaWZpY2F0aW9uIGNvbmRpdGlvbnMgd2hpY2ggY2FuIGJlIGJvb2xlYW5zIG9yIGZ1bmN0aW9uczsgdGhlIHB1cnBvc2Ugb2YgdGhpcyBhc3luYy9hd2FpdFxuICAgIC8vIHN0cnVjdHVyZSBpcyB0byBhdm9pZCB1bm5lY2Vzc2FyaWx5IGV4ZWN1dGluZyBzdWJzZXF1ZW50IGZ1bmN0aW9ucyBpZiBwcmV2aW91cyBvbmVzIGZhaWwgaW4gdGhlXG4gICAgLy8gY29uZGl0aW9uYWwgc3RhdGVtZW50IGJlbG93LCBhcyBhIGRldmVsb3BlciBtYXkgZGVjaWRlIHRvIGV4ZWN1dGUgZXhwZW5zaXZlIG9wZXJhdGlvbnMgaW4gdGhlbVxuICAgIGNvbnN0IHZlcmlmeVVzZXJFbWFpbHMgPSBhc3luYyAoKSA9PlxuICAgICAgdGhpcy5jb25maWcudmVyaWZ5VXNlckVtYWlscyA9PT0gdHJ1ZSB8fFxuICAgICAgKHR5cGVvZiB0aGlzLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzID09PSAnZnVuY3Rpb24nICYmXG4gICAgICAgIChhd2FpdCBQcm9taXNlLnJlc29sdmUodGhpcy5jb25maWcudmVyaWZ5VXNlckVtYWlscyhyZXF1ZXN0KSkpID09PSB0cnVlKTtcbiAgICBjb25zdCBwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID0gYXN5bmMgKCkgPT5cbiAgICAgIHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPT09IHRydWUgfHxcbiAgICAgICh0eXBlb2YgdGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCA9PT0gJ2Z1bmN0aW9uJyAmJlxuICAgICAgICAoYXdhaXQgUHJvbWlzZS5yZXNvbHZlKHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwocmVxdWVzdCkpKSA9PT0gdHJ1ZSk7XG4gICAgLy8gSWYgdmVyaWZpY2F0aW9uIGlzIHJlcXVpcmVkXG4gICAgaWYgKChhd2FpdCB2ZXJpZnlVc2VyRW1haWxzKCkpICYmIChhd2FpdCBwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsKCkpKSB7XG4gICAgICB0aGlzLnN0b3JhZ2UucmVqZWN0U2lnbnVwID0gdHJ1ZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNyZWF0ZVNlc3Npb25Ub2tlbiA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgLy8gY2xvdWQgaW5zdGFsbGF0aW9uSWQgZnJvbSBDbG91ZCBDb2RlLFxuICAvLyBuZXZlciBjcmVhdGUgc2Vzc2lvbiB0b2tlbnMgZnJvbSB0aGVyZS5cbiAgaWYgKHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCAmJiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQgPT09ICdjbG91ZCcpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA9PSBudWxsICYmIHRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmpvaW4oJywnKTtcbiAgfVxuXG4gIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IFJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uKHRoaXMuY29uZmlnLCB7XG4gICAgdXNlcklkOiB0aGlzLm9iamVjdElkKCksXG4gICAgY3JlYXRlZFdpdGg6IHtcbiAgICAgIGFjdGlvbjogdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA/ICdsb2dpbicgOiAnc2lnbnVwJyxcbiAgICAgIGF1dGhQcm92aWRlcjogdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciB8fCAncGFzc3dvcmQnLFxuICAgIH0sXG4gICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgfSk7XG5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2Uuc2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcbn07XG5cblJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uID0gZnVuY3Rpb24gKFxuICBjb25maWcsXG4gIHsgdXNlcklkLCBjcmVhdGVkV2l0aCwgaW5zdGFsbGF0aW9uSWQsIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSB9XG4pIHtcbiAgY29uc3QgdG9rZW4gPSAncjonICsgY3J5cHRvVXRpbHMubmV3VG9rZW4oKTtcbiAgY29uc3QgZXhwaXJlc0F0ID0gY29uZmlnLmdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCgpO1xuICBjb25zdCBzZXNzaW9uRGF0YSA9IHtcbiAgICBzZXNzaW9uVG9rZW46IHRva2VuLFxuICAgIHVzZXI6IHtcbiAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgb2JqZWN0SWQ6IHVzZXJJZCxcbiAgICB9LFxuICAgIGNyZWF0ZWRXaXRoLFxuICAgIGV4cGlyZXNBdDogUGFyc2UuX2VuY29kZShleHBpcmVzQXQpLFxuICB9O1xuXG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIHNlc3Npb25EYXRhLmluc3RhbGxhdGlvbklkID0gaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBPYmplY3QuYXNzaWduKHNlc3Npb25EYXRhLCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEpO1xuXG4gIHJldHVybiB7XG4gICAgc2Vzc2lvbkRhdGEsXG4gICAgY3JlYXRlU2Vzc2lvbjogKCkgPT5cbiAgICAgIG5ldyBSZXN0V3JpdGUoY29uZmlnLCBBdXRoLm1hc3Rlcihjb25maWcpLCAnX1Nlc3Npb24nLCBudWxsLCBzZXNzaW9uRGF0YSkuZXhlY3V0ZSgpLFxuICB9O1xufTtcblxuLy8gRGVsZXRlIGVtYWlsIHJlc2V0IHRva2VucyBpZiB1c2VyIGlzIGNoYW5naW5nIHBhc3N3b3JkIG9yIGVtYWlsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZWxldGVFbWFpbFJlc2V0VG9rZW5JZk5lZWRlZCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IHRoaXMucXVlcnkgPT09IG51bGwpIHtcbiAgICAvLyBudWxsIHF1ZXJ5IG1lYW5zIGNyZWF0ZVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgncGFzc3dvcmQnIGluIHRoaXMuZGF0YSB8fCAnZW1haWwnIGluIHRoaXMuZGF0YSkge1xuICAgIGNvbnN0IGFkZE9wcyA9IHtcbiAgICAgIF9wZXJpc2hhYmxlX3Rva2VuOiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgICBfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0OiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgfTtcbiAgICB0aGlzLmRhdGEgPSBPYmplY3QuYXNzaWduKHRoaXMuZGF0YSwgYWRkT3BzKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zID0gZnVuY3Rpb24gKCkge1xuICAvLyBPbmx5IGZvciBfU2Vzc2lvbiwgYW5kIGF0IGNyZWF0aW9uIHRpbWVcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9ICdfU2Vzc2lvbicgfHwgdGhpcy5xdWVyeSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEZXN0cm95IHRoZSBzZXNzaW9ucyBpbiAnQmFja2dyb3VuZCdcbiAgY29uc3QgeyB1c2VyLCBpbnN0YWxsYXRpb25JZCwgc2Vzc2lvblRva2VuIH0gPSB0aGlzLmRhdGE7XG4gIGlmICghdXNlciB8fCAhaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCF1c2VyLm9iamVjdElkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koXG4gICAgJ19TZXNzaW9uJyxcbiAgICB7XG4gICAgICB1c2VyLFxuICAgICAgaW5zdGFsbGF0aW9uSWQsXG4gICAgICBzZXNzaW9uVG9rZW46IHsgJG5lOiBzZXNzaW9uVG9rZW4gfSxcbiAgICB9LFxuICAgIHt9LFxuICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICk7XG59O1xuXG4vLyBIYW5kbGVzIGFueSBmb2xsb3d1cCBsb2dpY1xuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVGb2xsb3d1cCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSAmJiB0aGlzLmNvbmZpZy5yZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0KSB7XG4gICAgdmFyIHNlc3Npb25RdWVyeSA9IHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBkZWxldGUgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ107XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuZGVzdHJveSgnX1Nlc3Npb24nLCBzZXNzaW9uUXVlcnkpXG4gICAgICAudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnZ2VuZXJhdGVOZXdTZXNzaW9uJ107XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuKCkudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnc2VuZFZlcmlmaWNhdGlvbkVtYWlsJ107XG4gICAgLy8gRmlyZSBhbmQgZm9yZ2V0IVxuICAgIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNlbmRWZXJpZmljYXRpb25FbWFpbCh0aGlzLmRhdGEsIHsgYXV0aDogdGhpcy5hdXRoIH0pO1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcyk7XG4gIH1cbn07XG5cbi8vIEhhbmRsZXMgdGhlIF9TZXNzaW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gX1Nlc3Npb24gb2JqZWN0LlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVTZXNzaW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLmNsYXNzTmFtZSAhPT0gJ19TZXNzaW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLnVzZXIgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLCAnU2Vzc2lvbiB0b2tlbiByZXF1aXJlZC4nKTtcbiAgfVxuXG4gIC8vIFRPRE86IFZlcmlmeSBwcm9wZXIgZXJyb3IgdG8gdGhyb3dcbiAgaWYgKHRoaXMuZGF0YS5BQ0wpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0Nhbm5vdCBzZXQgJyArICdBQ0wgb24gYSBTZXNzaW9uLicpO1xuICB9XG5cbiAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICBpZiAodGhpcy5kYXRhLnVzZXIgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiB0aGlzLmRhdGEudXNlci5vYmplY3RJZCAhPSB0aGlzLmF1dGgudXNlci5pZCkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmRhdGEuc2Vzc2lvblRva2VuKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfVxuICAgIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgICB0aGlzLnF1ZXJ5ID0ge1xuICAgICAgICAkYW5kOiBbXG4gICAgICAgICAgdGhpcy5xdWVyeSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB1c2VyOiB7XG4gICAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgICAgICAgIG9iamVjdElkOiB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgY29uc3QgYWRkaXRpb25hbFNlc3Npb25EYXRhID0ge307XG4gICAgZm9yICh2YXIga2V5IGluIHRoaXMuZGF0YSkge1xuICAgICAgaWYgKGtleSA9PT0gJ29iamVjdElkJyB8fCBrZXkgPT09ICd1c2VyJykge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGFkZGl0aW9uYWxTZXNzaW9uRGF0YVtrZXldID0gdGhpcy5kYXRhW2tleV07XG4gICAgfVxuXG4gICAgY29uc3QgeyBzZXNzaW9uRGF0YSwgY3JlYXRlU2Vzc2lvbiB9ID0gUmVzdFdyaXRlLmNyZWF0ZVNlc3Npb24odGhpcy5jb25maWcsIHtcbiAgICAgIHVzZXJJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICBjcmVhdGVkV2l0aDoge1xuICAgICAgICBhY3Rpb246ICdjcmVhdGUnLFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSxcbiAgICB9KTtcblxuICAgIHJldHVybiBjcmVhdGVTZXNzaW9uKCkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmICghcmVzdWx0cy5yZXNwb25zZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLCAnRXJyb3IgY3JlYXRpbmcgc2Vzc2lvbi4nKTtcbiAgICAgIH1cbiAgICAgIHNlc3Npb25EYXRhWydvYmplY3RJZCddID0gcmVzdWx0cy5yZXNwb25zZVsnb2JqZWN0SWQnXTtcbiAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICBsb2NhdGlvbjogcmVzdWx0cy5sb2NhdGlvbixcbiAgICAgICAgcmVzcG9uc2U6IHNlc3Npb25EYXRhLFxuICAgICAgfTtcbiAgICB9KTtcbiAgfVxufTtcblxuLy8gSGFuZGxlcyB0aGUgX0luc3RhbGxhdGlvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIGluc3RhbGxhdGlvbiBvYmplY3QuXG4vLyBJZiBhbiBpbnN0YWxsYXRpb24gaXMgZm91bmQsIHRoaXMgY2FuIG11dGF0ZSB0aGlzLnF1ZXJ5IGFuZCB0dXJuIGEgY3JlYXRlXG4vLyBpbnRvIGFuIHVwZGF0ZS5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlSW5zdGFsbGF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLmNsYXNzTmFtZSAhPT0gJ19JbnN0YWxsYXRpb24nKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKFxuICAgICF0aGlzLnF1ZXJ5ICYmXG4gICAgIXRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAhdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIDEzNSxcbiAgICAgICdhdCBsZWFzdCBvbmUgSUQgZmllbGQgKGRldmljZVRva2VuLCBpbnN0YWxsYXRpb25JZCkgJyArICdtdXN0IGJlIHNwZWNpZmllZCBpbiB0aGlzIG9wZXJhdGlvbidcbiAgICApO1xuICB9XG5cbiAgLy8gSWYgdGhlIGRldmljZSB0b2tlbiBpcyA2NCBjaGFyYWN0ZXJzIGxvbmcsIHdlIGFzc3VtZSBpdCBpcyBmb3IgaU9TXG4gIC8vIGFuZCBsb3dlcmNhc2UgaXQuXG4gIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiYgdGhpcy5kYXRhLmRldmljZVRva2VuLmxlbmd0aCA9PSA2NCkge1xuICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiA9IHRoaXMuZGF0YS5kZXZpY2VUb2tlbi50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgLy8gV2UgbG93ZXJjYXNlIHRoZSBpbnN0YWxsYXRpb25JZCBpZiBwcmVzZW50XG4gIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQudG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIGxldCBpbnN0YWxsYXRpb25JZCA9IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZDtcblxuICAvLyBJZiBkYXRhLmluc3RhbGxhdGlvbklkIGlzIG5vdCBzZXQgYW5kIHdlJ3JlIG5vdCBtYXN0ZXIsIHdlIGNhbiBsb29rdXAgaW4gYXV0aFxuICBpZiAoIWluc3RhbGxhdGlvbklkICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBpbnN0YWxsYXRpb25JZCA9IGluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBVcGRhdGluZyBfSW5zdGFsbGF0aW9uIGJ1dCBub3QgdXBkYXRpbmcgYW55dGhpbmcgY3JpdGljYWxcbiAgaWYgKHRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiAhaW5zdGFsbGF0aW9uSWQgJiYgIXRoaXMuZGF0YS5kZXZpY2VUeXBlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICB2YXIgaWRNYXRjaDsgLy8gV2lsbCBiZSBhIG1hdGNoIG9uIGVpdGhlciBvYmplY3RJZCBvciBpbnN0YWxsYXRpb25JZFxuICB2YXIgb2JqZWN0SWRNYXRjaDtcbiAgdmFyIGluc3RhbGxhdGlvbklkTWF0Y2g7XG4gIHZhciBkZXZpY2VUb2tlbk1hdGNoZXMgPSBbXTtcblxuICAvLyBJbnN0ZWFkIG9mIGlzc3VpbmcgMyByZWFkcywgbGV0J3MgZG8gaXQgd2l0aCBvbmUgT1IuXG4gIGNvbnN0IG9yUXVlcmllcyA9IFtdO1xuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goe1xuICAgICAgb2JqZWN0SWQ6IHRoaXMucXVlcnkub2JqZWN0SWQsXG4gICAgfSk7XG4gIH1cbiAgaWYgKGluc3RhbGxhdGlvbklkKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goe1xuICAgICAgaW5zdGFsbGF0aW9uSWQ6IGluc3RhbGxhdGlvbklkLFxuICAgIH0pO1xuICB9XG4gIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7IGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gfSk7XG4gIH1cblxuICBpZiAob3JRdWVyaWVzLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgcHJvbWlzZSA9IHByb21pc2VcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICAgJ19JbnN0YWxsYXRpb24nLFxuICAgICAgICB7XG4gICAgICAgICAgJG9yOiBvclF1ZXJpZXMsXG4gICAgICAgIH0sXG4gICAgICAgIHt9XG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICByZXN1bHRzLmZvckVhY2gocmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCAmJiByZXN1bHQub2JqZWN0SWQgPT0gdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICAgIG9iamVjdElkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5pbnN0YWxsYXRpb25JZCA9PSBpbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIGluc3RhbGxhdGlvbklkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5kZXZpY2VUb2tlbiA9PSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgLy8gU2FuaXR5IGNoZWNrcyB3aGVuIHJ1bm5pbmcgYSBxdWVyeVxuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICBpZiAoIW9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQgZm9yIHVwZGF0ZS4nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAhPT0gb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM2LCAnaW5zdGFsbGF0aW9uSWQgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAhPT0gb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICAhb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM2LCAnZGV2aWNlVG9rZW4gbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICE9PSBvYmplY3RJZE1hdGNoLmRldmljZVR5cGVcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDEzNiwgJ2RldmljZVR5cGUgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIG9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgaWRNYXRjaCA9IG9iamVjdElkTWF0Y2g7XG4gICAgICB9XG5cbiAgICAgIGlmIChpbnN0YWxsYXRpb25JZCAmJiBpbnN0YWxsYXRpb25JZE1hdGNoKSB7XG4gICAgICAgIGlkTWF0Y2ggPSBpbnN0YWxsYXRpb25JZE1hdGNoO1xuICAgICAgfVxuICAgICAgLy8gbmVlZCB0byBzcGVjaWZ5IGRldmljZVR5cGUgb25seSBpZiBpdCdzIG5ld1xuICAgICAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJiAhaWRNYXRjaCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM1LCAnZGV2aWNlVHlwZSBtdXN0IGJlIHNwZWNpZmllZCBpbiB0aGlzIG9wZXJhdGlvbicpO1xuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgaWYgKCFpZE1hdGNoKSB7XG4gICAgICAgIGlmICghZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoID09IDEgJiZcbiAgICAgICAgICAoIWRldmljZVRva2VuTWF0Y2hlc1swXVsnaW5zdGFsbGF0aW9uSWQnXSB8fCAhaW5zdGFsbGF0aW9uSWQpXG4gICAgICAgICkge1xuICAgICAgICAgIC8vIFNpbmdsZSBtYXRjaCBvbiBkZXZpY2UgdG9rZW4gYnV0IG5vbmUgb24gaW5zdGFsbGF0aW9uSWQsIGFuZCBlaXRoZXJcbiAgICAgICAgICAvLyB0aGUgcGFzc2VkIG9iamVjdCBvciB0aGUgbWF0Y2ggaXMgbWlzc2luZyBhbiBpbnN0YWxsYXRpb25JZCwgc28gd2VcbiAgICAgICAgICAvLyBjYW4ganVzdCByZXR1cm4gdGhlIG1hdGNoLlxuICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgIH0gZWxzZSBpZiAoIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIDEzMixcbiAgICAgICAgICAgICdNdXN0IHNwZWNpZnkgaW5zdGFsbGF0aW9uSWQgd2hlbiBkZXZpY2VUb2tlbiAnICtcbiAgICAgICAgICAgICAgJ21hdGNoZXMgbXVsdGlwbGUgSW5zdGFsbGF0aW9uIG9iamVjdHMnXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBNdWx0aXBsZSBkZXZpY2UgdG9rZW4gbWF0Y2hlcyBhbmQgd2Ugc3BlY2lmaWVkIGFuIGluc3RhbGxhdGlvbiBJRCxcbiAgICAgICAgICAvLyBvciBhIHNpbmdsZSBtYXRjaCB3aGVyZSBib3RoIHRoZSBwYXNzZWQgYW5kIG1hdGNoaW5nIG9iamVjdHMgaGF2ZVxuICAgICAgICAgIC8vIGFuIGluc3RhbGxhdGlvbiBJRC4gVHJ5IGNsZWFuaW5nIG91dCBvbGQgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoXG4gICAgICAgICAgLy8gdGhlIGRldmljZVRva2VuLCBhbmQgcmV0dXJuIG5pbCB0byBzaWduYWwgdGhhdCBhIG5ldyBvYmplY3Qgc2hvdWxkXG4gICAgICAgICAgLy8gYmUgY3JlYXRlZC5cbiAgICAgICAgICB2YXIgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHtcbiAgICAgICAgICAgICAgJG5lOiBpbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfTtcbiAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KS5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgaWYgKGVyci5jb2RlID09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgLy8gbm8gZGVsZXRpb25zIHdlcmUgbWFkZS4gQ2FuIGJlIGlnbm9yZWQuXG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIHJldGhyb3cgdGhlIGVycm9yXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmICFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ10pIHtcbiAgICAgICAgICAvLyBFeGFjdGx5IG9uZSBkZXZpY2UgdG9rZW4gbWF0Y2ggYW5kIGl0IGRvZXNuJ3QgaGF2ZSBhbiBpbnN0YWxsYXRpb25cbiAgICAgICAgICAvLyBJRC4gVGhpcyBpcyB0aGUgb25lIGNhc2Ugd2hlcmUgd2Ugd2FudCB0byBtZXJnZSB3aXRoIHRoZSBleGlzdGluZ1xuICAgICAgICAgIC8vIG9iamVjdC5cbiAgICAgICAgICBjb25zdCBkZWxRdWVyeSA9IHsgb2JqZWN0SWQ6IGlkTWF0Y2gub2JqZWN0SWQgfTtcbiAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAgIC5kZXN0cm95KCdfSW5zdGFsbGF0aW9uJywgZGVsUXVlcnkpXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgICAgLy8gbm8gZGVsZXRpb25zIHdlcmUgbWFkZS4gQ2FuIGJlIGlnbm9yZWRcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgLy8gcmV0aHJvdyB0aGUgZXJyb3JcbiAgICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiBpZE1hdGNoLmRldmljZVRva2VuICE9IHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgICAgICAgICAgLy8gV2UncmUgc2V0dGluZyB0aGUgZGV2aWNlIHRva2VuIG9uIGFuIGV4aXN0aW5nIGluc3RhbGxhdGlvbiwgc29cbiAgICAgICAgICAgIC8vIHdlIHNob3VsZCB0cnkgY2xlYW5pbmcgb3V0IG9sZCBpbnN0YWxsYXRpb25zIHRoYXQgbWF0Y2ggdGhpc1xuICAgICAgICAgICAgLy8gZGV2aWNlIHRva2VuLlxuICAgICAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICAgIGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgLy8gV2UgaGF2ZSBhIHVuaXF1ZSBpbnN0YWxsIElkLCB1c2UgdGhhdCB0byBwcmVzZXJ2ZVxuICAgICAgICAgICAgLy8gdGhlIGludGVyZXN0aW5nIGluc3RhbGxhdGlvblxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgICAgICBkZWxRdWVyeVsnaW5zdGFsbGF0aW9uSWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgJiZcbiAgICAgICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgPT0gdGhpcy5kYXRhLm9iamVjdElkXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gd2UgcGFzc2VkIGFuIG9iamVjdElkLCBwcmVzZXJ2ZSB0aGF0IGluc3RhbGF0aW9uXG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydvYmplY3RJZCddID0ge1xuICAgICAgICAgICAgICAgICRuZTogaWRNYXRjaC5vYmplY3RJZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIFdoYXQgdG8gZG8gaGVyZT8gY2FuJ3QgcmVhbGx5IGNsZWFuIHVwIGV2ZXJ5dGhpbmcuLi5cbiAgICAgICAgICAgICAgcmV0dXJuIGlkTWF0Y2gub2JqZWN0SWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ2FwcElkZW50aWZpZXInXSA9IHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KS5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgICBpZiAoZXJyLmNvZGUgPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkLlxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAvLyByZXRocm93IHRoZSBlcnJvclxuICAgICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gSW4gbm9uLW1lcmdlIHNjZW5hcmlvcywganVzdCByZXR1cm4gdGhlIGluc3RhbGxhdGlvbiBtYXRjaCBpZFxuICAgICAgICAgIHJldHVybiBpZE1hdGNoLm9iamVjdElkO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSlcbiAgICAudGhlbihvYmpJZCA9PiB7XG4gICAgICBpZiAob2JqSWQpIHtcbiAgICAgICAgdGhpcy5xdWVyeSA9IHsgb2JqZWN0SWQ6IG9iaklkIH07XG4gICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuICAgICAgfVxuICAgICAgLy8gVE9ETzogVmFsaWRhdGUgb3BzIChhZGQvcmVtb3ZlIG9uIGNoYW5uZWxzLCAkaW5jIG9uIGJhZGdlLCBldGMuKVxuICAgIH0pO1xuICByZXR1cm4gcHJvbWlzZTtcbn07XG5cbi8vIElmIHdlIHNob3J0LWNpcmN1aXRlZCB0aGUgb2JqZWN0IHJlc3BvbnNlIC0gdGhlbiB3ZSBuZWVkIHRvIG1ha2Ugc3VyZSB3ZSBleHBhbmQgYWxsIHRoZSBmaWxlcyxcbi8vIHNpbmNlIHRoaXMgbWlnaHQgbm90IGhhdmUgYSBxdWVyeSwgbWVhbmluZyBpdCB3b24ndCByZXR1cm4gdGhlIGZ1bGwgcmVzdWx0IGJhY2suXG4vLyBUT0RPOiAobmx1dHNlbmtvKSBUaGlzIHNob3VsZCBkaWUgd2hlbiB3ZSBtb3ZlIHRvIHBlci1jbGFzcyBiYXNlZCBjb250cm9sbGVycyBvbiBfU2Vzc2lvbi9fVXNlclxuUmVzdFdyaXRlLnByb3RvdHlwZS5leHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgLy8gQ2hlY2sgd2hldGhlciB3ZSBoYXZlIGEgc2hvcnQtY2lyY3VpdGVkIHJlc3BvbnNlIC0gb25seSB0aGVuIHJ1biBleHBhbnNpb24uXG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICBhd2FpdCB0aGlzLmNvbmZpZy5maWxlc0NvbnRyb2xsZXIuZXhwYW5kRmlsZXNJbk9iamVjdCh0aGlzLmNvbmZpZywgdGhpcy5yZXNwb25zZS5yZXNwb25zZSk7XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuRGF0YWJhc2VPcGVyYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1JvbGUnKSB7XG4gICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnJvbGUuY2xlYXIoKTtcbiAgICBpZiAodGhpcy5jb25maWcubGl2ZVF1ZXJ5Q29udHJvbGxlcikge1xuICAgICAgdGhpcy5jb25maWcubGl2ZVF1ZXJ5Q29udHJvbGxlci5jbGVhckNhY2hlZFJvbGVzKHRoaXMuYXV0aC51c2VyKTtcbiAgICB9XG4gIH1cblxuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiYgdGhpcy5xdWVyeSAmJiB0aGlzLmF1dGguaXNVbmF1dGhlbnRpY2F0ZWQoKSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLlNFU1NJT05fTUlTU0lORyxcbiAgICAgIGBDYW5ub3QgbW9kaWZ5IHVzZXIgJHt0aGlzLnF1ZXJ5Lm9iamVjdElkfS5gXG4gICAgKTtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Qcm9kdWN0JyAmJiB0aGlzLmRhdGEuZG93bmxvYWQpIHtcbiAgICB0aGlzLmRhdGEuZG93bmxvYWROYW1lID0gdGhpcy5kYXRhLmRvd25sb2FkLm5hbWU7XG4gIH1cblxuICAvLyBUT0RPOiBBZGQgYmV0dGVyIGRldGVjdGlvbiBmb3IgQUNMLCBlbnN1cmluZyBhIHVzZXIgY2FuJ3QgYmUgbG9ja2VkIGZyb21cbiAgLy8gICAgICAgdGhlaXIgb3duIHVzZXIgcmVjb3JkLlxuICBpZiAodGhpcy5kYXRhLkFDTCAmJiB0aGlzLmRhdGEuQUNMWycqdW5yZXNvbHZlZCddKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfQUNMLCAnSW52YWxpZCBBQ0wuJyk7XG4gIH1cblxuICBpZiAodGhpcy5xdWVyeSkge1xuICAgIC8vIEZvcmNlIHRoZSB1c2VyIHRvIG5vdCBsb2Nrb3V0XG4gICAgLy8gTWF0Y2hlZCB3aXRoIHBhcnNlLmNvbVxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuQUNMICYmXG4gICAgICB0aGlzLmF1dGguaXNNYXN0ZXIgIT09IHRydWUgJiZcbiAgICAgIHRoaXMuYXV0aC5pc01haW50ZW5hbmNlICE9PSB0cnVlXG4gICAgKSB7XG4gICAgICB0aGlzLmRhdGEuQUNMW3RoaXMucXVlcnkub2JqZWN0SWRdID0geyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9O1xuICAgIH1cbiAgICAvLyB1cGRhdGUgcGFzc3dvcmQgdGltZXN0YW1wIGlmIHVzZXIgcGFzc3dvcmQgaXMgYmVpbmcgY2hhbmdlZFxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlXG4gICAgKSB7XG4gICAgICB0aGlzLmRhdGEuX3Bhc3N3b3JkX2NoYW5nZWRfYXQgPSBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKCkpO1xuICAgIH1cbiAgICAvLyBJZ25vcmUgY3JlYXRlZEF0IHdoZW4gdXBkYXRlXG4gICAgZGVsZXRlIHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG5cbiAgICBsZXQgZGVmZXIgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAvLyBpZiBwYXNzd29yZCBoaXN0b3J5IGlzIGVuYWJsZWQgdGhlbiBzYXZlIHRoZSBjdXJyZW50IHBhc3N3b3JkIHRvIGhpc3RvcnlcbiAgICBpZiAoXG4gICAgICB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICAgdGhpcy5kYXRhLl9oYXNoZWRfcGFzc3dvcmQgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnlcbiAgICApIHtcbiAgICAgIGRlZmVyID0gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgLmZpbmQoXG4gICAgICAgICAgJ19Vc2VyJyxcbiAgICAgICAgICB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgICB7IGtleXM6IFsnX3Bhc3N3b3JkX2hpc3RvcnknLCAnX2hhc2hlZF9wYXNzd29yZCddIH0sXG4gICAgICAgICAgQXV0aC5tYWludGVuYW5jZSh0aGlzLmNvbmZpZylcbiAgICAgICAgKVxuICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggIT0gMSkge1xuICAgICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCB1c2VyID0gcmVzdWx0c1swXTtcbiAgICAgICAgICBsZXQgb2xkUGFzc3dvcmRzID0gW107XG4gICAgICAgICAgaWYgKHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnkpIHtcbiAgICAgICAgICAgIG9sZFBhc3N3b3JkcyA9IF8udGFrZShcbiAgICAgICAgICAgICAgdXNlci5fcGFzc3dvcmRfaGlzdG9yeSxcbiAgICAgICAgICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5XG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvL24tMSBwYXNzd29yZHMgZ28gaW50byBoaXN0b3J5IGluY2x1ZGluZyBsYXN0IHBhc3N3b3JkXG4gICAgICAgICAgd2hpbGUgKFxuICAgICAgICAgICAgb2xkUGFzc3dvcmRzLmxlbmd0aCA+IE1hdGgubWF4KDAsIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDIpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICBvbGRQYXNzd29yZHMuc2hpZnQoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9oaXN0b3J5ID0gb2xkUGFzc3dvcmRzO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gZGVmZXIudGhlbigoKSA9PiB7XG4gICAgICAvLyBSdW4gYW4gdXBkYXRlXG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgLnVwZGF0ZShcbiAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICB0aGlzLnF1ZXJ5LFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICAgICAgKVxuICAgICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgICAgcmVzcG9uc2UudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgICAgdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShyZXNwb25zZSwgdGhpcy5kYXRhKTtcbiAgICAgICAgICB0aGlzLnJlc3BvbnNlID0geyByZXNwb25zZSB9O1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICAvLyBTZXQgdGhlIGRlZmF1bHQgQUNMIGFuZCBwYXNzd29yZCB0aW1lc3RhbXAgZm9yIHRoZSBuZXcgX1VzZXJcbiAgICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAgIHZhciBBQ0wgPSB0aGlzLmRhdGEuQUNMO1xuICAgICAgLy8gZGVmYXVsdCBwdWJsaWMgci93IEFDTFxuICAgICAgaWYgKCFBQ0wpIHtcbiAgICAgICAgQUNMID0ge307XG4gICAgICAgIGlmICghdGhpcy5jb25maWcuZW5mb3JjZVByaXZhdGVVc2Vycykge1xuICAgICAgICAgIEFDTFsnKiddID0geyByZWFkOiB0cnVlLCB3cml0ZTogZmFsc2UgfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gbWFrZSBzdXJlIHRoZSB1c2VyIGlzIG5vdCBsb2NrZWQgZG93blxuICAgICAgQUNMW3RoaXMuZGF0YS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgICB0aGlzLmRhdGEuQUNMID0gQUNMO1xuICAgICAgLy8gcGFzc3dvcmQgdGltZXN0YW1wIHRvIGJlIHVzZWQgd2hlbiBwYXNzd29yZCBleHBpcnkgcG9saWN5IGlzIGVuZm9yY2VkXG4gICAgICBpZiAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiYgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UpIHtcbiAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSdW4gYSBjcmVhdGVcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5jcmVhdGUodGhpcy5jbGFzc05hbWUsIHRoaXMuZGF0YSwgdGhpcy5ydW5PcHRpb25zLCBmYWxzZSwgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicgfHwgZXJyb3IuY29kZSAhPT0gUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBRdWljayBjaGVjaywgaWYgd2Ugd2VyZSBhYmxlIHRvIGluZmVyIHRoZSBkdXBsaWNhdGVkIGZpZWxkIG5hbWVcbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnVzZXJJbmZvICYmIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICd1c2VybmFtZScpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnVzZXJJbmZvICYmIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICdlbWFpbCcpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB0aGlzIHdhcyBhIGZhaWxlZCB1c2VyIGNyZWF0aW9uIGR1ZSB0byB1c2VybmFtZSBvciBlbWFpbCBhbHJlYWR5IHRha2VuLCB3ZSBuZWVkIHRvXG4gICAgICAgIC8vIGNoZWNrIHdoZXRoZXIgaXQgd2FzIHVzZXJuYW1lIG9yIGVtYWlsIGFuZCByZXR1cm4gdGhlIGFwcHJvcHJpYXRlIGVycm9yLlxuICAgICAgICAvLyBGYWxsYmFjayB0byB0aGUgb3JpZ2luYWwgbWV0aG9kXG4gICAgICAgIC8vIFRPRE86IFNlZSBpZiB3ZSBjYW4gbGF0ZXIgZG8gdGhpcyB3aXRob3V0IGFkZGl0aW9uYWwgcXVlcmllcyBieSB1c2luZyBuYW1lZCBpbmRleGVzLlxuICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAuZmluZChcbiAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB1c2VybmFtZTogdGhpcy5kYXRhLnVzZXJuYW1lLFxuICAgICAgICAgICAgICBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHsgbGltaXQ6IDEgfVxuICAgICAgICAgIClcbiAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOLFxuICAgICAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgeyBlbWFpbDogdGhpcy5kYXRhLmVtYWlsLCBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9IH0sXG4gICAgICAgICAgICAgIHsgbGltaXQ6IDEgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgcmVzcG9uc2Uub2JqZWN0SWQgPSB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gICAgICAgIHJlc3BvbnNlLmNyZWF0ZWRBdCA9IHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG5cbiAgICAgICAgaWYgKHRoaXMucmVzcG9uc2VTaG91bGRIYXZlVXNlcm5hbWUpIHtcbiAgICAgICAgICByZXNwb25zZS51c2VybmFtZSA9IHRoaXMuZGF0YS51c2VybmFtZTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKHJlc3BvbnNlLCB0aGlzLmRhdGEpO1xuICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICAgIHJlc3BvbnNlLFxuICAgICAgICAgIGxvY2F0aW9uOiB0aGlzLmxvY2F0aW9uKCksXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgfVxufTtcblxuLy8gUmV0dXJucyBub3RoaW5nIC0gZG9lc24ndCB3YWl0IGZvciB0aGUgdHJpZ2dlci5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQWZ0ZXJTYXZlVHJpZ2dlciA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLnJlc3BvbnNlIHx8ICF0aGlzLnJlc3BvbnNlLnJlc3BvbnNlIHx8IHRoaXMucnVuT3B0aW9ucy5tYW55KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYWZ0ZXJTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBjb25zdCBoYXNBZnRlclNhdmVIb29rID0gdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICApO1xuICBjb25zdCBoYXNMaXZlUXVlcnkgPSB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLmhhc0xpdmVRdWVyeSh0aGlzLmNsYXNzTmFtZSk7XG4gIGlmICghaGFzQWZ0ZXJTYXZlSG9vayAmJiAhaGFzTGl2ZVF1ZXJ5KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICB1cGRhdGVkT2JqZWN0Ll9oYW5kbGVTYXZlUmVzcG9uc2UodGhpcy5yZXNwb25zZS5yZXNwb25zZSwgdGhpcy5yZXNwb25zZS5zdGF0dXMgfHwgMjAwKTtcblxuICBpZiAoaGFzTGl2ZVF1ZXJ5KSB7XG4gICAgdGhpcy5jb25maWcuZGF0YWJhc2UubG9hZFNjaGVtYSgpLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICAvLyBOb3RpZnkgTGl2ZVF1ZXJ5U2VydmVyIGlmIHBvc3NpYmxlXG4gICAgICBjb25zdCBwZXJtcyA9IHNjaGVtYUNvbnRyb2xsZXIuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lKTtcbiAgICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIub25BZnRlclNhdmUoXG4gICAgICAgIHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgcGVybXNcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cbiAgaWYgKCFoYXNBZnRlclNhdmVIb29rKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFJ1biBhZnRlclNhdmUgdHJpZ2dlclxuICByZXR1cm4gdHJpZ2dlcnNcbiAgICAubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLFxuICAgICAgdGhpcy5hdXRoLFxuICAgICAgdXBkYXRlZE9iamVjdCxcbiAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLmNvbnRleHRcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgIGNvbnN0IGpzb25SZXR1cm5lZCA9IHJlc3VsdCAmJiAhcmVzdWx0Ll90b0Z1bGxKU09OO1xuICAgICAgaWYgKGpzb25SZXR1cm5lZCkge1xuICAgICAgICB0aGlzLnBlbmRpbmdPcHMub3BlcmF0aW9ucyA9IHt9O1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlID0gcmVzdWx0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZSA9IHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEoXG4gICAgICAgICAgKHJlc3VsdCB8fCB1cGRhdGVkT2JqZWN0KS50b0pTT04oKSxcbiAgICAgICAgICB0aGlzLmRhdGFcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBsb2dnZXIud2FybignYWZ0ZXJTYXZlIGNhdWdodCBhbiBlcnJvcicsIGVycik7XG4gICAgfSk7XG59O1xuXG4vLyBBIGhlbHBlciB0byBmaWd1cmUgb3V0IHdoYXQgbG9jYXRpb24gdGhpcyBvcGVyYXRpb24gaGFwcGVucyBhdC5cblJlc3RXcml0ZS5wcm90b3R5cGUubG9jYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBtaWRkbGUgPSB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyA/ICcvdXNlcnMvJyA6ICcvY2xhc3Nlcy8nICsgdGhpcy5jbGFzc05hbWUgKyAnLyc7XG4gIGNvbnN0IG1vdW50ID0gdGhpcy5jb25maWcubW91bnQgfHwgdGhpcy5jb25maWcuc2VydmVyVVJMO1xuICByZXR1cm4gbW91bnQgKyBtaWRkbGUgKyB0aGlzLmRhdGEub2JqZWN0SWQ7XG59O1xuXG4vLyBBIGhlbHBlciB0byBnZXQgdGhlIG9iamVjdCBpZCBmb3IgdGhpcyBvcGVyYXRpb24uXG4vLyBCZWNhdXNlIGl0IGNvdWxkIGJlIGVpdGhlciBvbiB0aGUgcXVlcnkgb3Igb24gdGhlIGRhdGFcblJlc3RXcml0ZS5wcm90b3R5cGUub2JqZWN0SWQgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLmRhdGEub2JqZWN0SWQgfHwgdGhpcy5xdWVyeS5vYmplY3RJZDtcbn07XG5cbi8vIFJldHVybnMgYSBjb3B5IG9mIHRoZSBkYXRhIGFuZCBkZWxldGUgYmFkIGtleXMgKF9hdXRoX2RhdGEsIF9oYXNoZWRfcGFzc3dvcmQuLi4pXG5SZXN0V3JpdGUucHJvdG90eXBlLnNhbml0aXplZERhdGEgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IGRhdGEgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLnJlZHVjZSgoZGF0YSwga2V5KSA9PiB7XG4gICAgLy8gUmVnZXhwIGNvbWVzIGZyb20gUGFyc2UuT2JqZWN0LnByb3RvdHlwZS52YWxpZGF0ZVxuICAgIGlmICghL15bQS1aYS16XVswLTlBLVphLXpfXSokLy50ZXN0KGtleSkpIHtcbiAgICAgIGRlbGV0ZSBkYXRhW2tleV07XG4gICAgfVxuICAgIHJldHVybiBkYXRhO1xuICB9LCBkZWVwY29weSh0aGlzLmRhdGEpKTtcbiAgcmV0dXJuIFBhcnNlLl9kZWNvZGUodW5kZWZpbmVkLCBkYXRhKTtcbn07XG5cbi8vIFJldHVybnMgYW4gdXBkYXRlZCBjb3B5IG9mIHRoZSBvYmplY3RcblJlc3RXcml0ZS5wcm90b3R5cGUuYnVpbGRQYXJzZU9iamVjdHMgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IGV4dHJhRGF0YSA9IHsgY2xhc3NOYW1lOiB0aGlzLmNsYXNzTmFtZSwgb2JqZWN0SWQ6IHRoaXMucXVlcnk/Lm9iamVjdElkIH07XG4gIGxldCBvcmlnaW5hbE9iamVjdDtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIG9yaWdpbmFsT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgfVxuXG4gIGNvbnN0IGNsYXNzTmFtZSA9IFBhcnNlLk9iamVjdC5mcm9tSlNPTihleHRyYURhdGEpO1xuICBjb25zdCByZWFkT25seUF0dHJpYnV0ZXMgPSBjbGFzc05hbWUuY29uc3RydWN0b3IucmVhZE9ubHlBdHRyaWJ1dGVzXG4gICAgPyBjbGFzc05hbWUuY29uc3RydWN0b3IucmVhZE9ubHlBdHRyaWJ1dGVzKClcbiAgICA6IFtdO1xuICBpZiAoIXRoaXMub3JpZ2luYWxEYXRhKSB7XG4gICAgZm9yIChjb25zdCBhdHRyaWJ1dGUgb2YgcmVhZE9ubHlBdHRyaWJ1dGVzKSB7XG4gICAgICBleHRyYURhdGFbYXR0cmlidXRlXSA9IHRoaXMuZGF0YVthdHRyaWJ1dGVdO1xuICAgIH1cbiAgfVxuICBjb25zdCB1cGRhdGVkT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgT2JqZWN0LmtleXModGhpcy5kYXRhKS5yZWR1Y2UoZnVuY3Rpb24gKGRhdGEsIGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgaWYgKHR5cGVvZiBkYXRhW2tleV0uX19vcCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKCFyZWFkT25seUF0dHJpYnV0ZXMuaW5jbHVkZXMoa2V5KSkge1xuICAgICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KGtleSwgZGF0YVtrZXldKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gc3ViZG9jdW1lbnQga2V5IHdpdGggZG90IG5vdGF0aW9uIHsgJ3gueSc6IHYgfSA9PiB7ICd4JzogeyAneScgOiB2IH0gfSlcbiAgICAgICAgY29uc3Qgc3BsaXR0ZWRLZXkgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgICAgY29uc3QgcGFyZW50UHJvcCA9IHNwbGl0dGVkS2V5WzBdO1xuICAgICAgICBsZXQgcGFyZW50VmFsID0gdXBkYXRlZE9iamVjdC5nZXQocGFyZW50UHJvcCk7XG4gICAgICAgIGlmICh0eXBlb2YgcGFyZW50VmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICAgIHBhcmVudFZhbCA9IHt9O1xuICAgICAgICB9XG4gICAgICAgIHBhcmVudFZhbFtzcGxpdHRlZEtleVsxXV0gPSBkYXRhW2tleV07XG4gICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KHBhcmVudFByb3AsIHBhcmVudFZhbCk7XG4gICAgICB9XG4gICAgICBkZWxldGUgZGF0YVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfSwgZGVlcGNvcHkodGhpcy5kYXRhKSk7XG5cbiAgY29uc3Qgc2FuaXRpemVkID0gdGhpcy5zYW5pdGl6ZWREYXRhKCk7XG4gIGZvciAoY29uc3QgYXR0cmlidXRlIG9mIHJlYWRPbmx5QXR0cmlidXRlcykge1xuICAgIGRlbGV0ZSBzYW5pdGl6ZWRbYXR0cmlidXRlXTtcbiAgfVxuICB1cGRhdGVkT2JqZWN0LnNldChzYW5pdGl6ZWQpO1xuICByZXR1cm4geyB1cGRhdGVkT2JqZWN0LCBvcmlnaW5hbE9iamVjdCB9O1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jbGVhblVzZXJBdXRoRGF0YSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSAmJiB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIGNvbnN0IHVzZXIgPSB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlO1xuICAgIGlmICh1c2VyLmF1dGhEYXRhKSB7XG4gICAgICBPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgICAgaWYgKHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdID09PSBudWxsKSB7XG4gICAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGlmIChPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5sZW5ndGggPT0gMCkge1xuICAgICAgICBkZWxldGUgdXNlci5hdXRoRGF0YTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEgPSBmdW5jdGlvbiAocmVzcG9uc2UsIGRhdGEpIHtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKHRoaXMucGVuZGluZ09wcy5pZGVudGlmaWVyKTtcbiAgZm9yIChjb25zdCBrZXkgaW4gdGhpcy5wZW5kaW5nT3BzLm9wZXJhdGlvbnMpIHtcbiAgICBpZiAoIXBlbmRpbmdba2V5XSkge1xuICAgICAgZGF0YVtrZXldID0gdGhpcy5vcmlnaW5hbERhdGEgPyB0aGlzLm9yaWdpbmFsRGF0YVtrZXldIDogeyBfX29wOiAnRGVsZXRlJyB9O1xuICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIucHVzaChrZXkpO1xuICAgIH1cbiAgfVxuICBjb25zdCBza2lwS2V5cyA9IFsuLi4ocmVxdWlyZWRDb2x1bW5zLnJlYWRbdGhpcy5jbGFzc05hbWVdIHx8IFtdKV07XG4gIGlmICghdGhpcy5xdWVyeSkge1xuICAgIHNraXBLZXlzLnB1c2goJ29iamVjdElkJywgJ2NyZWF0ZWRBdCcpO1xuICB9IGVsc2Uge1xuICAgIHNraXBLZXlzLnB1c2goJ3VwZGF0ZWRBdCcpO1xuICAgIGRlbGV0ZSByZXNwb25zZS5vYmplY3RJZDtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBpbiByZXNwb25zZSkge1xuICAgIGlmIChza2lwS2V5cy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgdmFsdWUgPSByZXNwb25zZVtrZXldO1xuICAgIGlmIChcbiAgICAgIHZhbHVlID09IG51bGwgfHxcbiAgICAgICh2YWx1ZS5fX3R5cGUgJiYgdmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKGRhdGFba2V5XSwgdmFsdWUpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKCh0aGlzLm9yaWdpbmFsRGF0YSB8fCB7fSlba2V5XSwgdmFsdWUpXG4gICAgKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2Vba2V5XTtcbiAgICB9XG4gIH1cbiAgaWYgKF8uaXNFbXB0eSh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlcikpIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgY2xpZW50U3VwcG9ydHNEZWxldGUgPSBDbGllbnRTREsuc3VwcG9ydHNGb3J3YXJkRGVsZXRlKHRoaXMuY2xpZW50U0RLKTtcbiAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGNvbnN0IGRhdGFWYWx1ZSA9IGRhdGFbZmllbGROYW1lXTtcblxuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3BvbnNlLCBmaWVsZE5hbWUpKSB7XG4gICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgIH1cblxuICAgIC8vIFN0cmlwcyBvcGVyYXRpb25zIGZyb20gcmVzcG9uc2VzXG4gICAgaWYgKHJlc3BvbnNlW2ZpZWxkTmFtZV0gJiYgcmVzcG9uc2VbZmllbGROYW1lXS5fX29wKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2VbZmllbGROYW1lXTtcbiAgICAgIGlmIChjbGllbnRTdXBwb3J0c0RlbGV0ZSAmJiBkYXRhVmFsdWUuX19vcCA9PSAnRGVsZXRlJykge1xuICAgICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiByZXNwb25zZTtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IFJlc3RXcml0ZTtcbm1vZHVsZS5leHBvcnRzID0gUmVzdFdyaXRlO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFl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
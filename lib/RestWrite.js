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
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == typeof i ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != typeof t || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != typeof i) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
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
    operations: _objectSpread({}, pending),
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
      var providerAuthData = authData[provider];
      var hasToken = providerAuthData && providerAuthData.id;
      return hasToken || providerAuthData === null;
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
  const r = await Auth.findUsersWithAuthData(this.config, authData);
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
          if (result)
            // reject if there is a match
            {
              return Promise.reject('REPEAT_PASSWORD');
            }
          return Promise.resolve();
        });
      });
      // wait for all comparisons to complete
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      }).catch(err => {
        if (err === 'REPEAT_PASSWORD')
          // a match was found
          {
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
  var _this$query;
  const extraData = {
    className: this.className,
    objectId: (_this$query = this.query) === null || _this$query === void 0 ? void 0 : _this$query.objectId
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUmVzdFF1ZXJ5IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9TY2hlbWFDb250cm9sbGVyIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0Iiwib3duS2V5cyIsInIiLCJ0IiwiT2JqZWN0Iiwia2V5cyIsImdldE93blByb3BlcnR5U3ltYm9scyIsIm8iLCJmaWx0ZXIiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IiLCJlbnVtZXJhYmxlIiwicHVzaCIsImFwcGx5IiwiX29iamVjdFNwcmVhZCIsImFyZ3VtZW50cyIsImxlbmd0aCIsImZvckVhY2giLCJfZGVmaW5lUHJvcGVydHkiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3JzIiwiZGVmaW5lUHJvcGVydGllcyIsImRlZmluZVByb3BlcnR5IiwiX3RvUHJvcGVydHlLZXkiLCJ2YWx1ZSIsImNvbmZpZ3VyYWJsZSIsIndyaXRhYmxlIiwiaSIsIl90b1ByaW1pdGl2ZSIsIlN5bWJvbCIsInRvUHJpbWl0aXZlIiwiY2FsbCIsIlR5cGVFcnJvciIsIlN0cmluZyIsIk51bWJlciIsIlNjaGVtYUNvbnRyb2xsZXIiLCJkZWVwY29weSIsIkF1dGgiLCJVdGlscyIsImNyeXB0b1V0aWxzIiwicGFzc3dvcmRDcnlwdG8iLCJQYXJzZSIsInRyaWdnZXJzIiwiQ2xpZW50U0RLIiwidXRpbCIsIlJlc3RXcml0ZSIsImNvbmZpZyIsImF1dGgiLCJjbGFzc05hbWUiLCJxdWVyeSIsImRhdGEiLCJvcmlnaW5hbERhdGEiLCJjbGllbnRTREsiLCJjb250ZXh0IiwiYWN0aW9uIiwiaXNSZWFkT25seSIsIkVycm9yIiwiT1BFUkFUSU9OX0ZPUkJJRERFTiIsInN0b3JhZ2UiLCJydW5PcHRpb25zIiwiYWxsb3dDdXN0b21PYmplY3RJZCIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5Iiwib2JqZWN0SWQiLCJNSVNTSU5HX09CSkVDVF9JRCIsIklOVkFMSURfS0VZX05BTUUiLCJpZCIsInJlc3BvbnNlIiwidXBkYXRlZEF0IiwiX2VuY29kZSIsIkRhdGUiLCJpc28iLCJ2YWxpZFNjaGVtYUNvbnRyb2xsZXIiLCJwZW5kaW5nT3BzIiwib3BlcmF0aW9ucyIsImlkZW50aWZpZXIiLCJleGVjdXRlIiwiUHJvbWlzZSIsInJlc29sdmUiLCJ0aGVuIiwiZ2V0VXNlckFuZFJvbGVBQ0wiLCJ2YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24iLCJoYW5kbGVJbnN0YWxsYXRpb24iLCJoYW5kbGVTZXNzaW9uIiwidmFsaWRhdGVBdXRoRGF0YSIsImNoZWNrUmVzdHJpY3RlZEZpZWxkcyIsInJ1bkJlZm9yZVNhdmVUcmlnZ2VyIiwiZW5zdXJlVW5pcXVlQXV0aERhdGFJZCIsImRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkIiwidmFsaWRhdGVTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwic2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCIsInRyYW5zZm9ybVVzZXIiLCJleHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyIsImRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMiLCJydW5EYXRhYmFzZU9wZXJhdGlvbiIsImNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkIiwiaGFuZGxlRm9sbG93dXAiLCJydW5BZnRlclNhdmVUcmlnZ2VyIiwiY2xlYW5Vc2VyQXV0aERhdGEiLCJhdXRoRGF0YVJlc3BvbnNlIiwicmVqZWN0U2lnbnVwIiwicHJldmVudFNpZ251cFdpdGhVbnZlcmlmaWVkRW1haWwiLCJFTUFJTF9OT1RfRk9VTkQiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJhY2wiLCJ1c2VyIiwiZ2V0VXNlclJvbGVzIiwicm9sZXMiLCJjb25jYXQiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwiaW5kZXhPZiIsImRhdGFiYXNlIiwibG9hZFNjaGVtYSIsImhhc0NsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJtYW55IiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYmVmb3JlU2F2ZSIsImFwcGxpY2F0aW9uSWQiLCJvcmlnaW5hbE9iamVjdCIsInVwZGF0ZWRPYmplY3QiLCJidWlsZFBhcnNlT2JqZWN0cyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJzdGF0ZUNvbnRyb2xsZXIiLCJDb3JlTWFuYWdlciIsImdldE9iamVjdFN0YXRlQ29udHJvbGxlciIsInBlbmRpbmciLCJnZXRQZW5kaW5nT3BzIiwiZGF0YWJhc2VQcm9taXNlIiwidXBkYXRlIiwiY3JlYXRlIiwicmVzdWx0IiwiT0JKRUNUX05PVF9GT1VORCIsIm1heWJlUnVuVHJpZ2dlciIsIm9iamVjdCIsImZpZWxkc0NoYW5nZWRCeVRyaWdnZXIiLCJfIiwicmVkdWNlIiwia2V5IiwiaXNFcXVhbCIsImNoZWNrUHJvaGliaXRlZEtleXdvcmRzIiwiZXJyb3IiLCJydW5CZWZvcmVMb2dpblRyaWdnZXIiLCJ1c2VyRGF0YSIsImJlZm9yZUxvZ2luIiwiZXh0cmFEYXRhIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsImluZmxhdGUiLCJnZXRBbGxDbGFzc2VzIiwiYWxsQ2xhc3NlcyIsInNjaGVtYSIsImZpbmQiLCJvbmVDbGFzcyIsInNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCIsImZpZWxkTmFtZSIsInNldERlZmF1bHQiLCJ1bmRlZmluZWQiLCJfX29wIiwiZmllbGRzIiwiZGVmYXVsdFZhbHVlIiwicmVxdWlyZWQiLCJWQUxJREFUSU9OX0VSUk9SIiwiYXNzaWduT2JqZWN0SWQiLCJuZXdPYmplY3RJZCIsIm9iamVjdElkU2l6ZSIsIm9iamVjdElkVXNlVGltZSIsIm9iamVjdElkUHJlZml4ZXMiLCJjcmVhdGVkQXQiLCJfX3R5cGUiLCJhdXRoRGF0YSIsImhhc1VzZXJuYW1lQW5kUGFzc3dvcmQiLCJ1c2VybmFtZSIsInBhc3N3b3JkIiwiaXNFbXB0eSIsIlVTRVJOQU1FX01JU1NJTkciLCJQQVNTV09SRF9NSVNTSU5HIiwiVU5TVVBQT1JURURfU0VSVklDRSIsInByb3ZpZGVycyIsImNhbkhhbmRsZUF1dGhEYXRhIiwic29tZSIsInByb3ZpZGVyIiwicHJvdmlkZXJBdXRoRGF0YSIsImhhc1Rva2VuIiwiZ2V0VXNlcklkIiwiaGFuZGxlQXV0aERhdGEiLCJmaWx0ZXJlZE9iamVjdHNCeUFDTCIsIm9iamVjdHMiLCJBQ0wiLCJoYXNBdXRoRGF0YUlkIiwiZmluZFVzZXJzV2l0aEF1dGhEYXRhIiwicmVzdWx0cyIsIkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQiLCJ1c2VySWQiLCJ1c2VyUmVzdWx0IiwiZm91bmRVc2VySXNOb3RDdXJyZW50VXNlciIsImhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiIsInZhbGlkYXRlZEF1dGhEYXRhIiwiYXV0aFByb3ZpZGVyIiwiam9pbiIsImhhc011dGF0ZWRBdXRoRGF0YSIsIm11dGF0ZWRBdXRoRGF0YSIsImlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3RlciIsImlzTG9naW4iLCJsb2NhdGlvbiIsImNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4iLCJhbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuIiwicmVzIiwicHJvbWlzZSIsIlJlc3RRdWVyeSIsIm1ldGhvZCIsIk1ldGhvZCIsIm1hc3RlciIsInJ1bkJlZm9yZUZpbmQiLCJyZXN0V2hlcmUiLCJzZXNzaW9uIiwiY2FjaGVDb250cm9sbGVyIiwiZGVsIiwic2Vzc2lvblRva2VuIiwiX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kiLCJoYXNoIiwiaGFzaGVkUGFzc3dvcmQiLCJfaGFzaGVkX3Bhc3N3b3JkIiwiX3ZhbGlkYXRlVXNlck5hbWUiLCJfdmFsaWRhdGVFbWFpbCIsInJhbmRvbVN0cmluZyIsInJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lIiwiJG5lIiwibGltaXQiLCJjYXNlSW5zZW5zaXRpdmUiLCJVU0VSTkFNRV9UQUtFTiIsImVtYWlsIiwibWF0Y2giLCJyZWplY3QiLCJJTlZBTElEX0VNQUlMX0FERFJFU1MiLCJFTUFJTF9UQUtFTiIsInJlcXVlc3QiLCJvcmlnaW5hbCIsImlwIiwiaW5zdGFsbGF0aW9uSWQiLCJ1c2VyQ29udHJvbGxlciIsInNldEVtYWlsVmVyaWZ5VG9rZW4iLCJwYXNzd29yZFBvbGljeSIsIl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzIiwiX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5IiwicG9saWN5RXJyb3IiLCJ2YWxpZGF0aW9uRXJyb3IiLCJjb250YWluc1VzZXJuYW1lRXJyb3IiLCJwYXR0ZXJuVmFsaWRhdG9yIiwidmFsaWRhdG9yQ2FsbGJhY2siLCJkb05vdEFsbG93VXNlcm5hbWUiLCJtYXhQYXNzd29yZEhpc3RvcnkiLCJtYWludGVuYW5jZSIsIm9sZFBhc3N3b3JkcyIsIl9wYXNzd29yZF9oaXN0b3J5IiwidGFrZSIsIm5ld1Bhc3N3b3JkIiwicHJvbWlzZXMiLCJtYXAiLCJjb21wYXJlIiwiYWxsIiwiY2F0Y2giLCJlcnIiLCJ2ZXJpZnlVc2VyRW1haWxzIiwicHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCIsImNyZWF0ZVNlc3Npb25Ub2tlbiIsInNlc3Npb25EYXRhIiwiY3JlYXRlU2Vzc2lvbiIsImNyZWF0ZWRXaXRoIiwiYWRkaXRpb25hbFNlc3Npb25EYXRhIiwidG9rZW4iLCJuZXdUb2tlbiIsImV4cGlyZXNBdCIsImdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCIsImFzc2lnbiIsImFkZE9wcyIsIl9wZXJpc2hhYmxlX3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsImRlc3Ryb3kiLCJyZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0Iiwic2Vzc2lvblF1ZXJ5IiwiYmluZCIsInNlbmRWZXJpZmljYXRpb25FbWFpbCIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsIiRhbmQiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJzdGF0dXMiLCJkZXZpY2VUb2tlbiIsInRvTG93ZXJDYXNlIiwiZGV2aWNlVHlwZSIsImlkTWF0Y2giLCJvYmplY3RJZE1hdGNoIiwiaW5zdGFsbGF0aW9uSWRNYXRjaCIsImRldmljZVRva2VuTWF0Y2hlcyIsIm9yUXVlcmllcyIsIiRvciIsImRlbFF1ZXJ5IiwiYXBwSWRlbnRpZmllciIsImNvZGUiLCJvYmpJZCIsInJvbGUiLCJjbGVhciIsImxpdmVRdWVyeUNvbnRyb2xsZXIiLCJjbGVhckNhY2hlZFJvbGVzIiwiaXNVbmF1dGhlbnRpY2F0ZWQiLCJTRVNTSU9OX01JU1NJTkciLCJkb3dubG9hZCIsImRvd25sb2FkTmFtZSIsIm5hbWUiLCJJTlZBTElEX0FDTCIsInJlYWQiLCJ3cml0ZSIsIm1heFBhc3N3b3JkQWdlIiwiX3Bhc3N3b3JkX2NoYW5nZWRfYXQiLCJkZWZlciIsIk1hdGgiLCJtYXgiLCJzaGlmdCIsIl91cGRhdGVSZXNwb25zZVdpdGhEYXRhIiwiZW5mb3JjZVByaXZhdGVVc2VycyIsIkRVUExJQ0FURV9WQUxVRSIsInVzZXJJbmZvIiwiZHVwbGljYXRlZF9maWVsZCIsImhhc0FmdGVyU2F2ZUhvb2siLCJhZnRlclNhdmUiLCJoYXNMaXZlUXVlcnkiLCJfaGFuZGxlU2F2ZVJlc3BvbnNlIiwicGVybXMiLCJnZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJvbkFmdGVyU2F2ZSIsImpzb25SZXR1cm5lZCIsIl90b0Z1bGxKU09OIiwidG9KU09OIiwibG9nZ2VyIiwid2FybiIsIm1pZGRsZSIsIm1vdW50Iiwic2VydmVyVVJMIiwic2FuaXRpemVkRGF0YSIsInRlc3QiLCJfZGVjb2RlIiwiX3RoaXMkcXVlcnkiLCJmcm9tSlNPTiIsInJlYWRPbmx5QXR0cmlidXRlcyIsImNvbnN0cnVjdG9yIiwiYXR0cmlidXRlIiwiaW5jbHVkZXMiLCJzZXQiLCJzcGxpdHRlZEtleSIsInNwbGl0IiwicGFyZW50UHJvcCIsInBhcmVudFZhbCIsImdldCIsInNhbml0aXplZCIsInNraXBLZXlzIiwicmVxdWlyZWRDb2x1bW5zIiwiaXNEZWVwU3RyaWN0RXF1YWwiLCJjbGllbnRTdXBwb3J0c0RlbGV0ZSIsInN1cHBvcnRzRm9yd2FyZERlbGV0ZSIsImRhdGFWYWx1ZSIsIl9kZWZhdWx0IiwiZXhwb3J0cyIsIm1vZHVsZSJdLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0V3JpdGUuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQSBSZXN0V3JpdGUgZW5jYXBzdWxhdGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCB0byBydW4gYW4gb3BlcmF0aW9uXG4vLyB0aGF0IHdyaXRlcyB0byB0aGUgZGF0YWJhc2UuXG4vLyBUaGlzIGNvdWxkIGJlIGVpdGhlciBhIFwiY3JlYXRlXCIgb3IgYW4gXCJ1cGRhdGVcIi5cblxudmFyIFNjaGVtYUNvbnRyb2xsZXIgPSByZXF1aXJlKCcuL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXInKTtcbnZhciBkZWVwY29weSA9IHJlcXVpcmUoJ2RlZXBjb3B5Jyk7XG5cbmNvbnN0IEF1dGggPSByZXF1aXJlKCcuL0F1dGgnKTtcbmNvbnN0IFV0aWxzID0gcmVxdWlyZSgnLi9VdGlscycpO1xudmFyIGNyeXB0b1V0aWxzID0gcmVxdWlyZSgnLi9jcnlwdG9VdGlscycpO1xudmFyIHBhc3N3b3JkQ3J5cHRvID0gcmVxdWlyZSgnLi9wYXNzd29yZCcpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpO1xudmFyIHRyaWdnZXJzID0gcmVxdWlyZSgnLi90cmlnZ2VycycpO1xudmFyIENsaWVudFNESyA9IHJlcXVpcmUoJy4vQ2xpZW50U0RLJyk7XG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuaW1wb3J0IFJlc3RRdWVyeSBmcm9tICcuL1Jlc3RRdWVyeSc7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IGxvZ2dlciBmcm9tICcuL2xvZ2dlcic7XG5pbXBvcnQgeyByZXF1aXJlZENvbHVtbnMgfSBmcm9tICcuL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXInO1xuXG4vLyBxdWVyeSBhbmQgZGF0YSBhcmUgYm90aCBwcm92aWRlZCBpbiBSRVNUIEFQSSBmb3JtYXQuIFNvIGRhdGFcbi8vIHR5cGVzIGFyZSBlbmNvZGVkIGJ5IHBsYWluIG9sZCBvYmplY3RzLlxuLy8gSWYgcXVlcnkgaXMgbnVsbCwgdGhpcyBpcyBhIFwiY3JlYXRlXCIgYW5kIHRoZSBkYXRhIGluIGRhdGEgc2hvdWxkIGJlXG4vLyBjcmVhdGVkLlxuLy8gT3RoZXJ3aXNlIHRoaXMgaXMgYW4gXCJ1cGRhdGVcIiAtIHRoZSBvYmplY3QgbWF0Y2hpbmcgdGhlIHF1ZXJ5XG4vLyBzaG91bGQgZ2V0IHVwZGF0ZWQgd2l0aCBkYXRhLlxuLy8gUmVzdFdyaXRlIHdpbGwgaGFuZGxlIG9iamVjdElkLCBjcmVhdGVkQXQsIGFuZCB1cGRhdGVkQXQgZm9yXG4vLyBldmVyeXRoaW5nLiBJdCBhbHNvIGtub3dzIHRvIHVzZSB0cmlnZ2VycyBhbmQgc3BlY2lhbCBtb2RpZmljYXRpb25zXG4vLyBmb3IgdGhlIF9Vc2VyIGNsYXNzLlxuZnVuY3Rpb24gUmVzdFdyaXRlKGNvbmZpZywgYXV0aCwgY2xhc3NOYW1lLCBxdWVyeSwgZGF0YSwgb3JpZ2luYWxEYXRhLCBjbGllbnRTREssIGNvbnRleHQsIGFjdGlvbikge1xuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICdDYW5ub3QgcGVyZm9ybSBhIHdyaXRlIG9wZXJhdGlvbiB3aGVuIHVzaW5nIHJlYWRPbmx5TWFzdGVyS2V5J1xuICAgICk7XG4gIH1cbiAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gIHRoaXMuYXV0aCA9IGF1dGg7XG4gIHRoaXMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB0aGlzLmNsaWVudFNESyA9IGNsaWVudFNESztcbiAgdGhpcy5zdG9yYWdlID0ge307XG4gIHRoaXMucnVuT3B0aW9ucyA9IHt9O1xuICB0aGlzLmNvbnRleHQgPSBjb250ZXh0IHx8IHt9O1xuXG4gIGlmIChhY3Rpb24pIHtcbiAgICB0aGlzLnJ1bk9wdGlvbnMuYWN0aW9uID0gYWN0aW9uO1xuICB9XG5cbiAgaWYgKCFxdWVyeSkge1xuICAgIGlmICh0aGlzLmNvbmZpZy5hbGxvd0N1c3RvbU9iamVjdElkKSB7XG4gICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGRhdGEsICdvYmplY3RJZCcpICYmICFkYXRhLm9iamVjdElkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5NSVNTSU5HX09CSkVDVF9JRCxcbiAgICAgICAgICAnb2JqZWN0SWQgbXVzdCBub3QgYmUgZW1wdHksIG51bGwgb3IgdW5kZWZpbmVkJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoZGF0YS5vYmplY3RJZCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ29iamVjdElkIGlzIGFuIGludmFsaWQgZmllbGQgbmFtZS4nKTtcbiAgICAgIH1cbiAgICAgIGlmIChkYXRhLmlkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnaWQgaXMgYW4gaW52YWxpZCBmaWVsZCBuYW1lLicpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFdoZW4gdGhlIG9wZXJhdGlvbiBpcyBjb21wbGV0ZSwgdGhpcy5yZXNwb25zZSBtYXkgaGF2ZSBzZXZlcmFsXG4gIC8vIGZpZWxkcy5cbiAgLy8gcmVzcG9uc2U6IHRoZSBhY3R1YWwgZGF0YSB0byBiZSByZXR1cm5lZFxuICAvLyBzdGF0dXM6IHRoZSBodHRwIHN0YXR1cyBjb2RlLiBpZiBub3QgcHJlc2VudCwgdHJlYXRlZCBsaWtlIGEgMjAwXG4gIC8vIGxvY2F0aW9uOiB0aGUgbG9jYXRpb24gaGVhZGVyLiBpZiBub3QgcHJlc2VudCwgbm8gbG9jYXRpb24gaGVhZGVyXG4gIHRoaXMucmVzcG9uc2UgPSBudWxsO1xuXG4gIC8vIFByb2Nlc3NpbmcgdGhpcyBvcGVyYXRpb24gbWF5IG11dGF0ZSBvdXIgZGF0YSwgc28gd2Ugb3BlcmF0ZSBvbiBhXG4gIC8vIGNvcHlcbiAgdGhpcy5xdWVyeSA9IGRlZXBjb3B5KHF1ZXJ5KTtcbiAgdGhpcy5kYXRhID0gZGVlcGNvcHkoZGF0YSk7XG4gIC8vIFdlIG5ldmVyIGNoYW5nZSBvcmlnaW5hbERhdGEsIHNvIHdlIGRvIG5vdCBuZWVkIGEgZGVlcCBjb3B5XG4gIHRoaXMub3JpZ2luYWxEYXRhID0gb3JpZ2luYWxEYXRhO1xuXG4gIC8vIFRoZSB0aW1lc3RhbXAgd2UnbGwgdXNlIGZvciB0aGlzIHdob2xlIG9wZXJhdGlvblxuICB0aGlzLnVwZGF0ZWRBdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSkuaXNvO1xuXG4gIC8vIFNoYXJlZCBTY2hlbWFDb250cm9sbGVyIHRvIGJlIHJldXNlZCB0byByZWR1Y2UgdGhlIG51bWJlciBvZiBsb2FkU2NoZW1hKCkgY2FsbHMgcGVyIHJlcXVlc3RcbiAgLy8gT25jZSBzZXQgdGhlIHNjaGVtYURhdGEgc2hvdWxkIGJlIGltbXV0YWJsZVxuICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlciA9IG51bGw7XG4gIHRoaXMucGVuZGluZ09wcyA9IHtcbiAgICBvcGVyYXRpb25zOiBudWxsLFxuICAgIGlkZW50aWZpZXI6IG51bGwsXG4gIH07XG59XG5cbi8vIEEgY29udmVuaWVudCBtZXRob2QgdG8gcGVyZm9ybSBhbGwgdGhlIHN0ZXBzIG9mIHByb2Nlc3NpbmcgdGhlXG4vLyB3cml0ZSwgaW4gb3JkZXIuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSB7cmVzcG9uc2UsIHN0YXR1cywgbG9jYXRpb259IG9iamVjdC5cbi8vIHN0YXR1cyBhbmQgbG9jYXRpb24gYXJlIG9wdGlvbmFsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5nZXRVc2VyQW5kUm9sZUFDTCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVJbnN0YWxsYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZVNlc3Npb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQXV0aERhdGEoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNoZWNrUmVzdHJpY3RlZEZpZWxkcygpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuQmVmb3JlU2F2ZVRyaWdnZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmVuc3VyZVVuaXF1ZUF1dGhEYXRhSWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZVNjaGVtYSgpO1xuICAgIH0pXG4gICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlciA9IHNjaGVtYUNvbnRyb2xsZXI7XG4gICAgICByZXR1cm4gdGhpcy5zZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy50cmFuc2Zvcm1Vc2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5leHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cygpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucygpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuRGF0YWJhc2VPcGVyYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVGb2xsb3d1cCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuQWZ0ZXJTYXZlVHJpZ2dlcigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY2xlYW5Vc2VyQXV0aERhdGEoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIEFwcGVuZCB0aGUgYXV0aERhdGFSZXNwb25zZSBpZiBleGlzdHNcbiAgICAgIGlmICh0aGlzLmF1dGhEYXRhUmVzcG9uc2UpIHtcbiAgICAgICAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UuYXV0aERhdGFSZXNwb25zZSA9IHRoaXMuYXV0aERhdGFSZXNwb25zZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHRoaXMuc3RvcmFnZS5yZWplY3RTaWdudXAgJiYgdGhpcy5jb25maWcucHJldmVudFNpZ251cFdpdGhVbnZlcmlmaWVkRW1haWwpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX05PVF9GT1VORCwgJ1VzZXIgZW1haWwgaXMgbm90IHZlcmlmaWVkLicpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRoaXMucmVzcG9uc2U7XG4gICAgfSk7XG59O1xuXG4vLyBVc2VzIHRoZSBBdXRoIG9iamVjdCB0byBnZXQgdGhlIGxpc3Qgb2Ygcm9sZXMsIGFkZHMgdGhlIHVzZXIgaWRcblJlc3RXcml0ZS5wcm90b3R5cGUuZ2V0VXNlckFuZFJvbGVBQ0wgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIgfHwgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB0aGlzLnJ1bk9wdGlvbnMuYWNsID0gWycqJ107XG5cbiAgaWYgKHRoaXMuYXV0aC51c2VyKSB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC5nZXRVc2VyUm9sZXMoKS50aGVuKHJvbGVzID0+IHtcbiAgICAgIHRoaXMucnVuT3B0aW9ucy5hY2wgPSB0aGlzLnJ1bk9wdGlvbnMuYWNsLmNvbmNhdChyb2xlcywgW3RoaXMuYXV0aC51c2VyLmlkXSk7XG4gICAgICByZXR1cm47XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIGNvbmZpZy5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAoXG4gICAgdGhpcy5jb25maWcuYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uID09PSBmYWxzZSAmJlxuICAgICF0aGlzLmF1dGguaXNNYXN0ZXIgJiZcbiAgICAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UgJiZcbiAgICBTY2hlbWFDb250cm9sbGVyLnN5c3RlbUNsYXNzZXMuaW5kZXhPZih0aGlzLmNsYXNzTmFtZSkgPT09IC0xXG4gICkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmhhc0NsYXNzKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAgIC50aGVuKGhhc0NsYXNzID0+IHtcbiAgICAgICAgaWYgKGhhc0NsYXNzICE9PSB0cnVlKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICAgICdUaGlzIHVzZXIgaXMgbm90IGFsbG93ZWQgdG8gYWNjZXNzICcgKyAnbm9uLWV4aXN0ZW50IGNsYXNzOiAnICsgdGhpcy5jbGFzc05hbWVcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBzY2hlbWEuXG5SZXN0V3JpdGUucHJvdG90eXBlLnZhbGlkYXRlU2NoZW1hID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UudmFsaWRhdGVPYmplY3QoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdGhpcy5kYXRhLFxuICAgIHRoaXMucXVlcnksXG4gICAgdGhpcy5ydW5PcHRpb25zLFxuICAgIHRoaXMuYXV0aC5pc01haW50ZW5hbmNlXG4gICk7XG59O1xuXG4vLyBSdW5zIGFueSBiZWZvcmVTYXZlIHRyaWdnZXJzIGFnYWluc3QgdGhpcyBvcGVyYXRpb24uXG4vLyBBbnkgY2hhbmdlIGxlYWRzIHRvIG91ciBkYXRhIGJlaW5nIG11dGF0ZWQuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkJlZm9yZVNhdmVUcmlnZ2VyID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLnJ1bk9wdGlvbnMubWFueSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2JlZm9yZVNhdmUnIHRyaWdnZXIgZm9yIHRoaXMgY2xhc3MuXG4gIGlmIChcbiAgICAhdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyh0aGlzLmNsYXNzTmFtZSwgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSwgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZClcbiAgKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICBjb25zdCBpZGVudGlmaWVyID0gdXBkYXRlZE9iamVjdC5fZ2V0U3RhdGVJZGVudGlmaWVyKCk7XG4gIGNvbnN0IHN0YXRlQ29udHJvbGxlciA9IFBhcnNlLkNvcmVNYW5hZ2VyLmdldE9iamVjdFN0YXRlQ29udHJvbGxlcigpO1xuICBjb25zdCBbcGVuZGluZ10gPSBzdGF0ZUNvbnRyb2xsZXIuZ2V0UGVuZGluZ09wcyhpZGVudGlmaWVyKTtcbiAgdGhpcy5wZW5kaW5nT3BzID0ge1xuICAgIG9wZXJhdGlvbnM6IHsgLi4ucGVuZGluZyB9LFxuICAgIGlkZW50aWZpZXIsXG4gIH07XG5cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gQmVmb3JlIGNhbGxpbmcgdGhlIHRyaWdnZXIsIHZhbGlkYXRlIHRoZSBwZXJtaXNzaW9ucyBmb3IgdGhlIHNhdmUgb3BlcmF0aW9uXG4gICAgICBsZXQgZGF0YWJhc2VQcm9taXNlID0gbnVsbDtcbiAgICAgIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIC8vIFZhbGlkYXRlIGZvciB1cGRhdGluZ1xuICAgICAgICBkYXRhYmFzZVByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS51cGRhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5xdWVyeSxcbiAgICAgICAgICB0aGlzLmRhdGEsXG4gICAgICAgICAgdGhpcy5ydW5PcHRpb25zLFxuICAgICAgICAgIHRydWUsXG4gICAgICAgICAgdHJ1ZVxuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gVmFsaWRhdGUgZm9yIGNyZWF0aW5nXG4gICAgICAgIGRhdGFiYXNlUHJvbWlzZSA9IHRoaXMuY29uZmlnLmRhdGFiYXNlLmNyZWF0ZShcbiAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICB0aGlzLmRhdGEsXG4gICAgICAgICAgdGhpcy5ydW5PcHRpb25zLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIEluIHRoZSBjYXNlIHRoYXQgdGhlcmUgaXMgbm8gcGVybWlzc2lvbiBmb3IgdGhlIG9wZXJhdGlvbiwgaXQgdGhyb3dzIGFuIGVycm9yXG4gICAgICByZXR1cm4gZGF0YWJhc2VQcm9taXNlLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKCFyZXN1bHQgfHwgcmVzdWx0Lmxlbmd0aCA8PSAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmlnZ2Vycy5tYXliZVJ1blRyaWdnZXIoXG4gICAgICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZVNhdmUsXG4gICAgICAgIHRoaXMuYXV0aCxcbiAgICAgICAgdXBkYXRlZE9iamVjdCxcbiAgICAgICAgb3JpZ2luYWxPYmplY3QsXG4gICAgICAgIHRoaXMuY29uZmlnLFxuICAgICAgICB0aGlzLmNvbnRleHRcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICBpZiAocmVzcG9uc2UgJiYgcmVzcG9uc2Uub2JqZWN0KSB7XG4gICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyID0gXy5yZWR1Y2UoXG4gICAgICAgICAgcmVzcG9uc2Uub2JqZWN0LFxuICAgICAgICAgIChyZXN1bHQsIHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VxdWFsKHRoaXMuZGF0YVtrZXldLCB2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgcmVzdWx0LnB1c2goa2V5KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBbXVxuICAgICAgICApO1xuICAgICAgICB0aGlzLmRhdGEgPSByZXNwb25zZS5vYmplY3Q7XG4gICAgICAgIC8vIFdlIHNob3VsZCBkZWxldGUgdGhlIG9iamVjdElkIGZvciBhbiB1cGRhdGUgd3JpdGVcbiAgICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIFV0aWxzLmNoZWNrUHJvaGliaXRlZEtleXdvcmRzKHRoaXMuY29uZmlnLCB0aGlzLmRhdGEpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsIGVycm9yKTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQmVmb3JlTG9naW5UcmlnZ2VyID0gYXN5bmMgZnVuY3Rpb24gKHVzZXJEYXRhKSB7XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2JlZm9yZUxvZ2luJyB0cmlnZ2VyXG4gIGlmIChcbiAgICAhdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyh0aGlzLmNsYXNzTmFtZSwgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlTG9naW4sIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWQpXG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENsb3VkIGNvZGUgZ2V0cyBhIGJpdCBvZiBleHRyYSBkYXRhIGZvciBpdHMgb2JqZWN0c1xuICBjb25zdCBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUgfTtcblxuICAvLyBFeHBhbmQgZmlsZSBvYmplY3RzXG4gIGF3YWl0IHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHRoaXMuY29uZmlnLCB1c2VyRGF0YSk7XG5cbiAgY29uc3QgdXNlciA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB1c2VyRGF0YSk7XG5cbiAgLy8gbm8gbmVlZCB0byByZXR1cm4gYSByZXNwb25zZVxuICBhd2FpdCB0cmlnZ2Vycy5tYXliZVJ1blRyaWdnZXIoXG4gICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlTG9naW4sXG4gICAgdGhpcy5hdXRoLFxuICAgIHVzZXIsXG4gICAgbnVsbCxcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmNvbnRleHRcbiAgKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuc2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuZGF0YSkge1xuICAgIHJldHVybiB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlci5nZXRBbGxDbGFzc2VzKCkudGhlbihhbGxDbGFzc2VzID0+IHtcbiAgICAgIGNvbnN0IHNjaGVtYSA9IGFsbENsYXNzZXMuZmluZChvbmVDbGFzcyA9PiBvbmVDbGFzcy5jbGFzc05hbWUgPT09IHRoaXMuY2xhc3NOYW1lKTtcbiAgICAgIGNvbnN0IHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCA9IChmaWVsZE5hbWUsIHNldERlZmF1bHQpID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gbnVsbCB8fFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnJyB8fFxuICAgICAgICAgICh0eXBlb2YgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09ICdvYmplY3QnICYmIHRoaXMuZGF0YVtmaWVsZE5hbWVdLl9fb3AgPT09ICdEZWxldGUnKVxuICAgICAgICApIHtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBzZXREZWZhdWx0ICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5kZWZhdWx0VmFsdWUgIT09IG51bGwgJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5kZWZhdWx0VmFsdWUgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAgICAgKHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICAgICAgKHR5cGVvZiB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gJ29iamVjdCcgJiYgdGhpcy5kYXRhW2ZpZWxkTmFtZV0uX19vcCA9PT0gJ0RlbGV0ZScpKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlO1xuICAgICAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciB8fCBbXTtcbiAgICAgICAgICAgIGlmICh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5pbmRleE9mKGZpZWxkTmFtZSkgPCAwKSB7XG4gICAgICAgICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucmVxdWlyZWQgPT09IHRydWUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBgJHtmaWVsZE5hbWV9IGlzIHJlcXVpcmVkYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICBjb25zdCBhc3NpZ25PYmplY3RJZCA9ICgpID0+IHtcbiAgICAgICAgY29uc3Qgb2JqZWN0SWQgPSBjcnlwdG9VdGlscy5uZXdPYmplY3RJZChcbiAgICAgICAgICB0aGlzLmNvbmZpZy5vYmplY3RJZFNpemUsXG4gICAgICAgICAgdGhpcy5jb25maWcub2JqZWN0SWRVc2VUaW1lXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCF0aGlzLmNvbmZpZy5vYmplY3RJZFByZWZpeGVzKSB7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdElkO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5vYmplY3RJZFByZWZpeGVzW3RoaXMuY2xhc3NOYW1lXVxuICAgICAgICAgID8gYCR7dGhpcy5jb25maWcub2JqZWN0SWRQcmVmaXhlc1t0aGlzLmNsYXNzTmFtZV19JHtvYmplY3RJZH1gXG4gICAgICAgICAgOiBvYmplY3RJZDtcbiAgICAgIH07XG5cbiAgICAgIC8vIEFkZCBkZWZhdWx0IGZpZWxkc1xuICAgICAgaWYgKCF0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIC8vIGFsbG93IGN1c3RvbWl6aW5nIGNyZWF0ZWRBdCBhbmQgdXBkYXRlZEF0IHdoZW4gdXNpbmcgbWFpbnRlbmFuY2Uga2V5XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0Ll9fdHlwZSA9PT0gJ0RhdGUnXG4gICAgICAgICkge1xuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0LmlzbztcblxuICAgICAgICAgIGlmICh0aGlzLmRhdGEudXBkYXRlZEF0ICYmIHRoaXMuZGF0YS51cGRhdGVkQXQuX190eXBlID09PSAnRGF0ZScpIHtcbiAgICAgICAgICAgIGNvbnN0IGNyZWF0ZWRBdCA9IG5ldyBEYXRlKHRoaXMuZGF0YS5jcmVhdGVkQXQpO1xuICAgICAgICAgICAgY29uc3QgdXBkYXRlZEF0ID0gbmV3IERhdGUodGhpcy5kYXRhLnVwZGF0ZWRBdC5pc28pO1xuXG4gICAgICAgICAgICBpZiAodXBkYXRlZEF0IDwgY3JlYXRlZEF0KSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgICd1cGRhdGVkQXQgY2Fubm90IG9jY3VyIGJlZm9yZSBjcmVhdGVkQXQnXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLmRhdGEudXBkYXRlZEF0LmlzbztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gaWYgbm8gdXBkYXRlZEF0IGlzIHByb3ZpZGVkLCBzZXQgaXQgdG8gY3JlYXRlZEF0IHRvIG1hdGNoIGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gT25seSBhc3NpZ24gbmV3IG9iamVjdElkIGlmIHdlIGFyZSBjcmVhdGluZyBuZXcgb2JqZWN0XG4gICAgICAgIGlmICghdGhpcy5kYXRhLm9iamVjdElkKSB7XG4gICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gYXNzaWduT2JqZWN0SWQoKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2NoZW1hKSB7XG4gICAgICAgICAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgc2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkKGZpZWxkTmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcblxuICAgICAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQoZmllbGROYW1lLCBmYWxzZSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cbi8vIFRyYW5zZm9ybXMgYXV0aCBkYXRhIGZvciBhIHVzZXIgb2JqZWN0LlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYSB1c2VyIG9iamVjdC5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVBdXRoRGF0YSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYXV0aERhdGEgPSB0aGlzLmRhdGEuYXV0aERhdGE7XG4gIGNvbnN0IGhhc1VzZXJuYW1lQW5kUGFzc3dvcmQgPVxuICAgIHR5cGVvZiB0aGlzLmRhdGEudXNlcm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiB0aGlzLmRhdGEucGFzc3dvcmQgPT09ICdzdHJpbmcnO1xuXG4gIGlmICghdGhpcy5xdWVyeSAmJiAhYXV0aERhdGEpIHtcbiAgICBpZiAodHlwZW9mIHRoaXMuZGF0YS51c2VybmFtZSAhPT0gJ3N0cmluZycgfHwgXy5pc0VtcHR5KHRoaXMuZGF0YS51c2VybmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5VU0VSTkFNRV9NSVNTSU5HLCAnYmFkIG9yIG1pc3NpbmcgdXNlcm5hbWUnKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB0aGlzLmRhdGEucGFzc3dvcmQgIT09ICdzdHJpbmcnIHx8IF8uaXNFbXB0eSh0aGlzLmRhdGEucGFzc3dvcmQpKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuUEFTU1dPUkRfTUlTU0lORywgJ3Bhc3N3b3JkIGlzIHJlcXVpcmVkJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKFxuICAgIChhdXRoRGF0YSAmJiAhT2JqZWN0LmtleXMoYXV0aERhdGEpLmxlbmd0aCkgfHxcbiAgICAhT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHRoaXMuZGF0YSwgJ2F1dGhEYXRhJylcbiAgKSB7XG4gICAgLy8gTm90aGluZyB0byB2YWxpZGF0ZSBoZXJlXG4gICAgcmV0dXJuO1xuICB9IGVsc2UgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh0aGlzLmRhdGEsICdhdXRoRGF0YScpICYmICF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICAvLyBIYW5kbGUgc2F2aW5nIGF1dGhEYXRhIHRvIG51bGxcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLidcbiAgICApO1xuICB9XG5cbiAgdmFyIHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgaWYgKHByb3ZpZGVycy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY2FuSGFuZGxlQXV0aERhdGEgPSBwcm92aWRlcnMuc29tZShwcm92aWRlciA9PiB7XG4gICAgICB2YXIgcHJvdmlkZXJBdXRoRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgIHZhciBoYXNUb2tlbiA9IHByb3ZpZGVyQXV0aERhdGEgJiYgcHJvdmlkZXJBdXRoRGF0YS5pZDtcbiAgICAgIHJldHVybiBoYXNUb2tlbiB8fCBwcm92aWRlckF1dGhEYXRhID09PSBudWxsO1xuICAgIH0pO1xuICAgIGlmIChjYW5IYW5kbGVBdXRoRGF0YSB8fCBoYXNVc2VybmFtZUFuZFBhc3N3b3JkIHx8IHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmdldFVzZXJJZCgpKSB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoRGF0YShhdXRoRGF0YSk7XG4gICAgfVxuICB9XG4gIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbHRlcmVkT2JqZWN0c0J5QUNMID0gZnVuY3Rpb24gKG9iamVjdHMpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybiBvYmplY3RzO1xuICB9XG4gIHJldHVybiBvYmplY3RzLmZpbHRlcihvYmplY3QgPT4ge1xuICAgIGlmICghb2JqZWN0LkFDTCkge1xuICAgICAgcmV0dXJuIHRydWU7IC8vIGxlZ2FjeSB1c2VycyB0aGF0IGhhdmUgbm8gQUNMIGZpZWxkIG9uIHRoZW1cbiAgICB9XG4gICAgLy8gUmVndWxhciB1c2VycyB0aGF0IGhhdmUgYmVlbiBsb2NrZWQgb3V0LlxuICAgIHJldHVybiBvYmplY3QuQUNMICYmIE9iamVjdC5rZXlzKG9iamVjdC5BQ0wpLmxlbmd0aCA+IDA7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VySWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gdGhpcy5xdWVyeS5vYmplY3RJZDtcbiAgfSBlbHNlIGlmICh0aGlzLmF1dGggJiYgdGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLnVzZXIuaWQ7XG4gIH1cbn07XG5cbi8vIERldmVsb3BlcnMgYXJlIGFsbG93ZWQgdG8gY2hhbmdlIGF1dGhEYXRhIHZpYSBiZWZvcmUgc2F2ZSB0cmlnZ2VyXG4vLyB3ZSBuZWVkIGFmdGVyIGJlZm9yZSBzYXZlIHRvIGVuc3VyZSB0aGF0IHRoZSBkZXZlbG9wZXJcbi8vIGlzIG5vdCBjdXJyZW50bHkgZHVwbGljYXRpbmcgYXV0aCBkYXRhIElEXG5SZXN0V3JpdGUucHJvdG90eXBlLmVuc3VyZVVuaXF1ZUF1dGhEYXRhSWQgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaGFzQXV0aERhdGFJZCA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkuc29tZShcbiAgICBrZXkgPT4gdGhpcy5kYXRhLmF1dGhEYXRhW2tleV0gJiYgdGhpcy5kYXRhLmF1dGhEYXRhW2tleV0uaWRcbiAgKTtcblxuICBpZiAoIWhhc0F1dGhEYXRhSWQpIHsgcmV0dXJuOyB9XG5cbiAgY29uc3QgciA9IGF3YWl0IEF1dGguZmluZFVzZXJzV2l0aEF1dGhEYXRhKHRoaXMuY29uZmlnLCB0aGlzLmRhdGEuYXV0aERhdGEpO1xuICBjb25zdCByZXN1bHRzID0gdGhpcy5maWx0ZXJlZE9iamVjdHNCeUFDTChyKTtcbiAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG4gIC8vIHVzZSBkYXRhLm9iamVjdElkIGluIGNhc2Ugb2YgbG9naW4gdGltZSBhbmQgZm91bmQgdXNlciBkdXJpbmcgaGFuZGxlIHZhbGlkYXRlQXV0aERhdGFcbiAgY29uc3QgdXNlcklkID0gdGhpcy5nZXRVc2VySWQoKSB8fCB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gIGlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMSAmJiB1c2VySWQgIT09IHJlc3VsdHNbMF0ub2JqZWN0SWQpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuQUNDT1VOVF9BTFJFQURZX0xJTktFRCwgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVBdXRoRGF0YSA9IGFzeW5jIGZ1bmN0aW9uIChhdXRoRGF0YSkge1xuICBjb25zdCByID0gYXdhaXQgQXV0aC5maW5kVXNlcnNXaXRoQXV0aERhdGEodGhpcy5jb25maWcsIGF1dGhEYXRhKTtcbiAgY29uc3QgcmVzdWx0cyA9IHRoaXMuZmlsdGVyZWRPYmplY3RzQnlBQ0wocik7XG5cbiAgY29uc3QgdXNlcklkID0gdGhpcy5nZXRVc2VySWQoKTtcbiAgY29uc3QgdXNlclJlc3VsdCA9IHJlc3VsdHNbMF07XG4gIGNvbnN0IGZvdW5kVXNlcklzTm90Q3VycmVudFVzZXIgPSB1c2VySWQgJiYgdXNlclJlc3VsdCAmJiB1c2VySWQgIT09IHVzZXJSZXN1bHQub2JqZWN0SWQ7XG5cbiAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMSB8fCBmb3VuZFVzZXJJc05vdEN1cnJlbnRVc2VyKSB7XG4gICAgLy8gVG8gYXZvaWQgaHR0cHM6Ly9naXRodWIuY29tL3BhcnNlLWNvbW11bml0eS9wYXJzZS1zZXJ2ZXIvc2VjdXJpdHkvYWR2aXNvcmllcy9HSFNBLTh3M2otZzk4My04amg1XG4gICAgLy8gTGV0J3MgcnVuIHNvbWUgdmFsaWRhdGlvbiBiZWZvcmUgdGhyb3dpbmdcbiAgICBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihhdXRoRGF0YSwgdGhpcywgdXNlclJlc3VsdCk7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsICd0aGlzIGF1dGggaXMgYWxyZWFkeSB1c2VkJyk7XG4gIH1cblxuICAvLyBObyB1c2VyIGZvdW5kIHdpdGggcHJvdmlkZWQgYXV0aERhdGEgd2UgbmVlZCB0byB2YWxpZGF0ZVxuICBpZiAoIXJlc3VsdHMubGVuZ3RoKSB7XG4gICAgY29uc3QgeyBhdXRoRGF0YTogdmFsaWRhdGVkQXV0aERhdGEsIGF1dGhEYXRhUmVzcG9uc2UgfSA9IGF3YWl0IEF1dGguaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKFxuICAgICAgYXV0aERhdGEsXG4gICAgICB0aGlzXG4gICAgKTtcbiAgICB0aGlzLmF1dGhEYXRhUmVzcG9uc2UgPSBhdXRoRGF0YVJlc3BvbnNlO1xuICAgIC8vIFJlcGxhY2UgY3VycmVudCBhdXRoRGF0YSBieSB0aGUgbmV3IHZhbGlkYXRlZCBvbmVcbiAgICB0aGlzLmRhdGEuYXV0aERhdGEgPSB2YWxpZGF0ZWRBdXRoRGF0YTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBVc2VyIGZvdW5kIHdpdGggcHJvdmlkZWQgYXV0aERhdGFcbiAgaWYgKHJlc3VsdHMubGVuZ3RoID09PSAxKSB7XG5cbiAgICB0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyID0gT2JqZWN0LmtleXMoYXV0aERhdGEpLmpvaW4oJywnKTtcblxuICAgIGNvbnN0IHsgaGFzTXV0YXRlZEF1dGhEYXRhLCBtdXRhdGVkQXV0aERhdGEgfSA9IEF1dGguaGFzTXV0YXRlZEF1dGhEYXRhKFxuICAgICAgYXV0aERhdGEsXG4gICAgICB1c2VyUmVzdWx0LmF1dGhEYXRhXG4gICAgKTtcblxuICAgIGNvbnN0IGlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3RlciA9XG4gICAgICAodGhpcy5hdXRoICYmIHRoaXMuYXV0aC51c2VyICYmIHRoaXMuYXV0aC51c2VyLmlkID09PSB1c2VyUmVzdWx0Lm9iamVjdElkKSB8fFxuICAgICAgdGhpcy5hdXRoLmlzTWFzdGVyO1xuXG4gICAgY29uc3QgaXNMb2dpbiA9ICF1c2VySWQ7XG5cbiAgICBpZiAoaXNMb2dpbiB8fCBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIpIHtcbiAgICAgIC8vIG5vIHVzZXIgbWFraW5nIHRoZSBjYWxsXG4gICAgICAvLyBPUiB0aGUgdXNlciBtYWtpbmcgdGhlIGNhbGwgaXMgdGhlIHJpZ2h0IG9uZVxuICAgICAgLy8gTG9naW4gd2l0aCBhdXRoIGRhdGFcbiAgICAgIGRlbGV0ZSByZXN1bHRzWzBdLnBhc3N3b3JkO1xuXG4gICAgICAvLyBuZWVkIHRvIHNldCB0aGUgb2JqZWN0SWQgZmlyc3Qgb3RoZXJ3aXNlIGxvY2F0aW9uIGhhcyB0cmFpbGluZyB1bmRlZmluZWRcbiAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCA9IHVzZXJSZXN1bHQub2JqZWN0SWQ7XG5cbiAgICAgIGlmICghdGhpcy5xdWVyeSB8fCAhdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgIHJlc3BvbnNlOiB1c2VyUmVzdWx0LFxuICAgICAgICAgIGxvY2F0aW9uOiB0aGlzLmxvY2F0aW9uKCksXG4gICAgICAgIH07XG4gICAgICAgIC8vIFJ1biBiZWZvcmVMb2dpbiBob29rIGJlZm9yZSBzdG9yaW5nIGFueSB1cGRhdGVzXG4gICAgICAgIC8vIHRvIGF1dGhEYXRhIG9uIHRoZSBkYjsgY2hhbmdlcyB0byB1c2VyUmVzdWx0XG4gICAgICAgIC8vIHdpbGwgYmUgaWdub3JlZC5cbiAgICAgICAgYXdhaXQgdGhpcy5ydW5CZWZvcmVMb2dpblRyaWdnZXIoZGVlcGNvcHkodXNlclJlc3VsdCkpO1xuXG4gICAgICAgIC8vIElmIHdlIGFyZSBpbiBsb2dpbiBvcGVyYXRpb24gdmlhIGF1dGhEYXRhXG4gICAgICAgIC8vIHdlIG5lZWQgdG8gYmUgc3VyZSB0aGF0IHRoZSB1c2VyIGhhcyBwcm92aWRlZFxuICAgICAgICAvLyByZXF1aXJlZCBhdXRoRGF0YVxuICAgICAgICBBdXRoLmNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4oXG4gICAgICAgICAgeyBjb25maWc6IHRoaXMuY29uZmlnLCBhdXRoOiB0aGlzLmF1dGggfSxcbiAgICAgICAgICBhdXRoRGF0YSxcbiAgICAgICAgICB1c2VyUmVzdWx0LmF1dGhEYXRhLFxuICAgICAgICAgIHRoaXMuY29uZmlnXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIC8vIFByZXZlbnQgdmFsaWRhdGluZyBpZiBubyBtdXRhdGVkIGRhdGEgZGV0ZWN0ZWQgb24gdXBkYXRlXG4gICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSAmJiBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBGb3JjZSB0byB2YWxpZGF0ZSBhbGwgcHJvdmlkZWQgYXV0aERhdGEgb24gbG9naW5cbiAgICAgIC8vIG9uIHVwZGF0ZSBvbmx5IHZhbGlkYXRlIG11dGF0ZWQgb25lc1xuICAgICAgaWYgKGhhc011dGF0ZWRBdXRoRGF0YSB8fCAhdGhpcy5jb25maWcuYWxsb3dFeHBpcmVkQXV0aERhdGFUb2tlbikge1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihcbiAgICAgICAgICBpc0xvZ2luID8gYXV0aERhdGEgOiBtdXRhdGVkQXV0aERhdGEsXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICB1c2VyUmVzdWx0XG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGF0YS5hdXRoRGF0YSA9IHJlcy5hdXRoRGF0YTtcbiAgICAgICAgdGhpcy5hdXRoRGF0YVJlc3BvbnNlID0gcmVzLmF1dGhEYXRhUmVzcG9uc2U7XG4gICAgICB9XG5cbiAgICAgIC8vIElGIHdlIGFyZSBpbiBsb2dpbiB3ZSdsbCBza2lwIHRoZSBkYXRhYmFzZSBvcGVyYXRpb24gLyBiZWZvcmVTYXZlIC8gYWZ0ZXJTYXZlIGV0Yy4uLlxuICAgICAgLy8gd2UgbmVlZCB0byBzZXQgaXQgdXAgdGhlcmUuXG4gICAgICAvLyBXZSBhcmUgc3VwcG9zZWQgdG8gaGF2ZSBhIHJlc3BvbnNlIG9ubHkgb24gTE9HSU4gd2l0aCBhdXRoRGF0YSwgc28gd2Ugc2tpcCB0aG9zZVxuICAgICAgLy8gSWYgd2UncmUgbm90IGxvZ2dpbmcgaW4sIGJ1dCBqdXN0IHVwZGF0aW5nIHRoZSBjdXJyZW50IHVzZXIsIHdlIGNhbiBzYWZlbHkgc2tpcCB0aGF0IHBhcnRcbiAgICAgIGlmICh0aGlzLnJlc3BvbnNlKSB7XG4gICAgICAgIC8vIEFzc2lnbiB0aGUgbmV3IGF1dGhEYXRhIGluIHRoZSByZXNwb25zZVxuICAgICAgICBPYmplY3Qua2V5cyhtdXRhdGVkQXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UuYXV0aERhdGFbcHJvdmlkZXJdID0gbXV0YXRlZEF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gUnVuIHRoZSBEQiB1cGRhdGUgZGlyZWN0bHksIGFzICdtYXN0ZXInIG9ubHkgaWYgYXV0aERhdGEgY29udGFpbnMgc29tZSBrZXlzXG4gICAgICAgIC8vIGF1dGhEYXRhIGNvdWxkIG5vdCBjb250YWlucyBrZXlzIGFmdGVyIHZhbGlkYXRpb24gaWYgdGhlIGF1dGhBZGFwdGVyXG4gICAgICAgIC8vIHVzZXMgdGhlIGBkb05vdFNhdmVgIG9wdGlvbi4gSnVzdCB1cGRhdGUgdGhlIGF1dGhEYXRhIHBhcnRcbiAgICAgICAgLy8gVGhlbiB3ZSdyZSBnb29kIGZvciB0aGUgdXNlciwgZWFybHkgZXhpdCBvZiBzb3J0c1xuICAgICAgICBpZiAoT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGgpIHtcbiAgICAgICAgICBhd2FpdCB0aGlzLmNvbmZpZy5kYXRhYmFzZS51cGRhdGUoXG4gICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMuZGF0YS5vYmplY3RJZCB9LFxuICAgICAgICAgICAgeyBhdXRoRGF0YTogdGhpcy5kYXRhLmF1dGhEYXRhIH0sXG4gICAgICAgICAgICB7fVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY2hlY2tSZXN0cmljdGVkRmllbGRzID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgJ2VtYWlsVmVyaWZpZWQnIGluIHRoaXMuZGF0YSkge1xuICAgIGNvbnN0IGVycm9yID0gYENsaWVudHMgYXJlbid0IGFsbG93ZWQgdG8gbWFudWFsbHkgdXBkYXRlIGVtYWlsIHZlcmlmaWNhdGlvbi5gO1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLCBlcnJvcik7XG4gIH1cbn07XG5cbi8vIFRoZSBub24tdGhpcmQtcGFydHkgcGFydHMgb2YgVXNlciB0cmFuc2Zvcm1hdGlvblxuUmVzdFdyaXRlLnByb3RvdHlwZS50cmFuc2Zvcm1Vc2VyID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIC8vIERvIG5vdCBjbGVhbnVwIHNlc3Npb24gaWYgb2JqZWN0SWQgaXMgbm90IHNldFxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLm9iamVjdElkKCkpIHtcbiAgICAvLyBJZiB3ZSdyZSB1cGRhdGluZyBhIF9Vc2VyIG9iamVjdCwgd2UgbmVlZCB0byBjbGVhciBvdXQgdGhlIGNhY2hlIGZvciB0aGF0IHVzZXIuIEZpbmQgYWxsIHRoZWlyXG4gICAgLy8gc2Vzc2lvbiB0b2tlbnMsIGFuZCByZW1vdmUgdGhlbSBmcm9tIHRoZSBjYWNoZS5cbiAgICBjb25zdCBxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZmluZCxcbiAgICAgIGNvbmZpZzogdGhpcy5jb25maWcsXG4gICAgICBhdXRoOiBBdXRoLm1hc3Rlcih0aGlzLmNvbmZpZyksXG4gICAgICBjbGFzc05hbWU6ICdfU2Vzc2lvbicsXG4gICAgICBydW5CZWZvcmVGaW5kOiBmYWxzZSxcbiAgICAgIHJlc3RXaGVyZToge1xuICAgICAgICB1c2VyOiB7XG4gICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHByb21pc2UgPSBxdWVyeS5leGVjdXRlKCkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMucmVzdWx0cy5mb3JFYWNoKHNlc3Npb24gPT5cbiAgICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnVzZXIuZGVsKHNlc3Npb24uc2Vzc2lvblRva2VuKVxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBwcm9taXNlXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gVHJhbnNmb3JtIHRoZSBwYXNzd29yZFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIC8vIGlnbm9yZSBvbmx5IGlmIHVuZGVmaW5lZC4gc2hvdWxkIHByb2NlZWQgaWYgZW1wdHkgKCcnKVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddID0gdHJ1ZTtcbiAgICAgICAgLy8gR2VuZXJhdGUgYSBuZXcgc2Vzc2lvbiBvbmx5IGlmIHRoZSB1c2VyIHJlcXVlc3RlZFxuICAgICAgICBpZiAoIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICAgICAgICB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uaGFzaCh0aGlzLmRhdGEucGFzc3dvcmQpLnRoZW4oaGFzaGVkUGFzc3dvcmQgPT4ge1xuICAgICAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkID0gaGFzaGVkUGFzc3dvcmQ7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVVzZXJOYW1lKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVFbWFpbCgpO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVVc2VyTmFtZSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gQ2hlY2sgZm9yIHVzZXJuYW1lIHVuaXF1ZW5lc3NcbiAgaWYgKCF0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgIHRoaXMuZGF0YS51c2VybmFtZSA9IGNyeXB0b1V0aWxzLnJhbmRvbVN0cmluZygyNSk7XG4gICAgICB0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8qXG4gICAgVXNlcm5hbWVzIHNob3VsZCBiZSB1bmlxdWUgd2hlbiBjb21wYXJlZCBjYXNlIGluc2Vuc2l0aXZlbHlcblxuICAgIFVzZXJzIHNob3VsZCBiZSBhYmxlIHRvIG1ha2UgY2FzZSBzZW5zaXRpdmUgdXNlcm5hbWVzIGFuZFxuICAgIGxvZ2luIHVzaW5nIHRoZSBjYXNlIHRoZXkgZW50ZXJlZC4gIEkuZS4gJ1Nub29weScgc2hvdWxkIHByZWNsdWRlXG4gICAgJ3Nub29weScgYXMgYSB2YWxpZCB1c2VybmFtZS5cbiAgKi9cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHtcbiAgICAgICAgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSxcbiAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgIH0sXG4gICAgICB7IGxpbWl0OiAxLCBjYXNlSW5zZW5zaXRpdmU6IHRydWUgfSxcbiAgICAgIHt9LFxuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfSk7XG59O1xuXG4vKlxuICBBcyB3aXRoIHVzZXJuYW1lcywgUGFyc2Ugc2hvdWxkIG5vdCBhbGxvdyBjYXNlIGluc2Vuc2l0aXZlIGNvbGxpc2lvbnMgb2YgZW1haWwuXG4gIHVubGlrZSB3aXRoIHVzZXJuYW1lcyAod2hpY2ggY2FuIGhhdmUgY2FzZSBpbnNlbnNpdGl2ZSBjb2xsaXNpb25zIGluIHRoZSBjYXNlIG9mXG4gIGF1dGggYWRhcHRlcnMpLCBlbWFpbHMgc2hvdWxkIG5ldmVyIGhhdmUgYSBjYXNlIGluc2Vuc2l0aXZlIGNvbGxpc2lvbi5cblxuICBUaGlzIGJlaGF2aW9yIGNhbiBiZSBlbmZvcmNlZCB0aHJvdWdoIGEgcHJvcGVybHkgY29uZmlndXJlZCBpbmRleCBzZWU6XG4gIGh0dHBzOi8vZG9jcy5tb25nb2RiLmNvbS9tYW51YWwvY29yZS9pbmRleC1jYXNlLWluc2Vuc2l0aXZlLyNjcmVhdGUtYS1jYXNlLWluc2Vuc2l0aXZlLWluZGV4XG4gIHdoaWNoIGNvdWxkIGJlIGltcGxlbWVudGVkIGluc3RlYWQgb2YgdGhpcyBjb2RlIGJhc2VkIHZhbGlkYXRpb24uXG5cbiAgR2l2ZW4gdGhhdCB0aGlzIGxvb2t1cCBzaG91bGQgYmUgYSByZWxhdGl2ZWx5IGxvdyB1c2UgY2FzZSBhbmQgdGhhdCB0aGUgY2FzZSBzZW5zaXRpdmVcbiAgdW5pcXVlIGluZGV4IHdpbGwgYmUgdXNlZCBieSB0aGUgZGIgZm9yIHRoZSBxdWVyeSwgdGhpcyBpcyBhbiBhZGVxdWF0ZSBzb2x1dGlvbi5cbiovXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZUVtYWlsID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuZGF0YS5lbWFpbCB8fCB0aGlzLmRhdGEuZW1haWwuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gVmFsaWRhdGUgYmFzaWMgZW1haWwgYWRkcmVzcyBmb3JtYXRcbiAgaWYgKCF0aGlzLmRhdGEuZW1haWwubWF0Y2goL14uK0AuKyQvKSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0VNQUlMX0FERFJFU1MsICdFbWFpbCBhZGRyZXNzIGZvcm1hdCBpcyBpbnZhbGlkLicpXG4gICAgKTtcbiAgfVxuICAvLyBDYXNlIGluc2Vuc2l0aXZlIG1hdGNoLCBzZWUgbm90ZSBhYm92ZSBmdW5jdGlvbi5cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHtcbiAgICAgICAgZW1haWw6IHRoaXMuZGF0YS5lbWFpbCxcbiAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgIH0sXG4gICAgICB7IGxpbWl0OiAxLCBjYXNlSW5zZW5zaXRpdmU6IHRydWUgfSxcbiAgICAgIHt9LFxuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgIXRoaXMuZGF0YS5hdXRoRGF0YSB8fFxuICAgICAgICAhT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGggfHxcbiAgICAgICAgKE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoID09PSAxICYmXG4gICAgICAgICAgT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKVswXSA9PT0gJ2Fub255bW91cycpXG4gICAgICApIHtcbiAgICAgICAgLy8gV2UgdXBkYXRlZCB0aGUgZW1haWwsIHNlbmQgYSBuZXcgdmFsaWRhdGlvblxuICAgICAgICBjb25zdCB7IG9yaWdpbmFsT2JqZWN0LCB1cGRhdGVkT2JqZWN0IH0gPSB0aGlzLmJ1aWxkUGFyc2VPYmplY3RzKCk7XG4gICAgICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICAgICAgb3JpZ2luYWw6IG9yaWdpbmFsT2JqZWN0LFxuICAgICAgICAgIG9iamVjdDogdXBkYXRlZE9iamVjdCxcbiAgICAgICAgICBtYXN0ZXI6IHRoaXMuYXV0aC5pc01hc3RlcixcbiAgICAgICAgICBpcDogdGhpcy5jb25maWcuaXAsXG4gICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgfTtcbiAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNldEVtYWlsVmVyaWZ5VG9rZW4odGhpcy5kYXRhLCByZXF1ZXN0LCB0aGlzLnN0b3JhZ2UpO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSkgeyByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7IH1cbiAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMoKS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkoKTtcbiAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzID0gZnVuY3Rpb24gKCkge1xuICAvLyBjaGVjayBpZiB0aGUgcGFzc3dvcmQgY29uZm9ybXMgdG8gdGhlIGRlZmluZWQgcGFzc3dvcmQgcG9saWN5IGlmIGNvbmZpZ3VyZWRcbiAgLy8gSWYgd2Ugc3BlY2lmaWVkIGEgY3VzdG9tIGVycm9yIGluIG91ciBjb25maWd1cmF0aW9uIHVzZSBpdC5cbiAgLy8gRXhhbXBsZTogXCJQYXNzd29yZHMgbXVzdCBpbmNsdWRlIGEgQ2FwaXRhbCBMZXR0ZXIsIExvd2VyY2FzZSBMZXR0ZXIsIGFuZCBhIG51bWJlci5cIlxuICAvL1xuICAvLyBUaGlzIGlzIGVzcGVjaWFsbHkgdXNlZnVsIG9uIHRoZSBnZW5lcmljIFwicGFzc3dvcmQgcmVzZXRcIiBwYWdlLFxuICAvLyBhcyBpdCBhbGxvd3MgdGhlIHByb2dyYW1tZXIgdG8gY29tbXVuaWNhdGUgc3BlY2lmaWMgcmVxdWlyZW1lbnRzIGluc3RlYWQgb2Y6XG4gIC8vIGEuIG1ha2luZyB0aGUgdXNlciBndWVzcyB3aGF0cyB3cm9uZ1xuICAvLyBiLiBtYWtpbmcgYSBjdXN0b20gcGFzc3dvcmQgcmVzZXQgcGFnZSB0aGF0IHNob3dzIHRoZSByZXF1aXJlbWVudHNcbiAgY29uc3QgcG9saWN5RXJyb3IgPSB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0aW9uRXJyb3JcbiAgICA/IHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRpb25FcnJvclxuICAgIDogJ1Bhc3N3b3JkIGRvZXMgbm90IG1lZXQgdGhlIFBhc3N3b3JkIFBvbGljeSByZXF1aXJlbWVudHMuJztcbiAgY29uc3QgY29udGFpbnNVc2VybmFtZUVycm9yID0gJ1Bhc3N3b3JkIGNhbm5vdCBjb250YWluIHlvdXIgdXNlcm5hbWUuJztcblxuICAvLyBjaGVjayB3aGV0aGVyIHRoZSBwYXNzd29yZCBtZWV0cyB0aGUgcGFzc3dvcmQgc3RyZW5ndGggcmVxdWlyZW1lbnRzXG4gIGlmIChcbiAgICAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kucGF0dGVyblZhbGlkYXRvciAmJlxuICAgICAgIXRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnBhdHRlcm5WYWxpZGF0b3IodGhpcy5kYXRhLnBhc3N3b3JkKSkgfHxcbiAgICAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sgJiZcbiAgICAgICF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayh0aGlzLmRhdGEucGFzc3dvcmQpKVxuICApIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIHBvbGljeUVycm9yKSk7XG4gIH1cblxuICAvLyBjaGVjayB3aGV0aGVyIHBhc3N3b3JkIGNvbnRhaW4gdXNlcm5hbWVcbiAgaWYgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LmRvTm90QWxsb3dVc2VybmFtZSA9PT0gdHJ1ZSkge1xuICAgIGlmICh0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICAgIC8vIHVzZXJuYW1lIGlzIG5vdCBwYXNzZWQgZHVyaW5nIHBhc3N3b3JkIHJlc2V0XG4gICAgICBpZiAodGhpcy5kYXRhLnBhc3N3b3JkLmluZGV4T2YodGhpcy5kYXRhLnVzZXJuYW1lKSA+PSAwKVxuICAgICAgeyByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIGNvbnRhaW5zVXNlcm5hbWVFcnJvcikpOyB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHJldHJpZXZlIHRoZSBVc2VyIG9iamVjdCB1c2luZyBvYmplY3RJZCBkdXJpbmcgcGFzc3dvcmQgcmVzZXRcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKCdfVXNlcicsIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9KS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggIT0gMSkge1xuICAgICAgICAgIHRocm93IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAodGhpcy5kYXRhLnBhc3N3b3JkLmluZGV4T2YocmVzdWx0c1swXS51c2VybmFtZSkgPj0gMClcbiAgICAgICAgeyByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIGNvbnRhaW5zVXNlcm5hbWVFcnJvcilcbiAgICAgICAgKTsgfVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIGNoZWNrIHdoZXRoZXIgcGFzc3dvcmQgaXMgcmVwZWF0aW5nIGZyb20gc3BlY2lmaWVkIGhpc3RvcnlcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5KSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuZmluZChcbiAgICAgICAgJ19Vc2VyJyxcbiAgICAgICAgeyBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgIHsga2V5czogWydfcGFzc3dvcmRfaGlzdG9yeScsICdfaGFzaGVkX3Bhc3N3b3JkJ10gfSxcbiAgICAgICAgQXV0aC5tYWludGVuYW5jZSh0aGlzLmNvbmZpZylcbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggIT0gMSkge1xuICAgICAgICAgIHRocm93IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB1c2VyID0gcmVzdWx0c1swXTtcbiAgICAgICAgbGV0IG9sZFBhc3N3b3JkcyA9IFtdO1xuICAgICAgICBpZiAodXNlci5fcGFzc3dvcmRfaGlzdG9yeSlcbiAgICAgICAgeyBvbGRQYXNzd29yZHMgPSBfLnRha2UoXG4gICAgICAgICAgdXNlci5fcGFzc3dvcmRfaGlzdG9yeSxcbiAgICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgLSAxXG4gICAgICAgICk7IH1cbiAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgIGNvbnN0IG5ld1Bhc3N3b3JkID0gdGhpcy5kYXRhLnBhc3N3b3JkO1xuICAgICAgICAvLyBjb21wYXJlIHRoZSBuZXcgcGFzc3dvcmQgaGFzaCB3aXRoIGFsbCBvbGQgcGFzc3dvcmQgaGFzaGVzXG4gICAgICAgIGNvbnN0IHByb21pc2VzID0gb2xkUGFzc3dvcmRzLm1hcChmdW5jdGlvbiAoaGFzaCkge1xuICAgICAgICAgIHJldHVybiBwYXNzd29yZENyeXB0by5jb21wYXJlKG5ld1Bhc3N3b3JkLCBoYXNoKS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0KVxuICAgICAgICAgICAgLy8gcmVqZWN0IGlmIHRoZXJlIGlzIGEgbWF0Y2hcbiAgICAgICAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KCdSRVBFQVRfUEFTU1dPUkQnKTsgfVxuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgLy8gd2FpdCBmb3IgYWxsIGNvbXBhcmlzb25zIHRvIGNvbXBsZXRlXG4gICAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcylcbiAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuY2F0Y2goZXJyID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIgPT09ICdSRVBFQVRfUEFTU1dPUkQnKVxuICAgICAgICAgICAgLy8gYSBtYXRjaCB3YXMgZm91bmRcbiAgICAgICAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUixcbiAgICAgICAgICAgICAgICBgTmV3IHBhc3N3b3JkIHNob3VsZCBub3QgYmUgdGhlIHNhbWUgYXMgbGFzdCAke3RoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeX0gcGFzc3dvcmRzLmBcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTsgfVxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERvbid0IGdlbmVyYXRlIHNlc3Npb24gZm9yIHVwZGF0aW5nIHVzZXIgKHRoaXMucXVlcnkgaXMgc2V0KSB1bmxlc3MgYXV0aERhdGEgZXhpc3RzXG4gIGlmICh0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gRG9uJ3QgZ2VuZXJhdGUgbmV3IHNlc3Npb25Ub2tlbiBpZiBsaW5raW5nIHZpYSBzZXNzaW9uVG9rZW5cbiAgaWYgKHRoaXMuYXV0aC51c2VyICYmIHRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBJZiBzaWduLXVwIGNhbGxcbiAgaWYgKCF0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyKSB7XG4gICAgLy8gQ3JlYXRlIHJlcXVlc3Qgb2JqZWN0IGZvciB2ZXJpZmljYXRpb24gZnVuY3Rpb25zXG4gICAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICBvcmlnaW5hbDogb3JpZ2luYWxPYmplY3QsXG4gICAgICBvYmplY3Q6IHVwZGF0ZWRPYmplY3QsXG4gICAgICBtYXN0ZXI6IHRoaXMuYXV0aC5pc01hc3RlcixcbiAgICAgIGlwOiB0aGlzLmNvbmZpZy5pcCxcbiAgICAgIGluc3RhbGxhdGlvbklkOiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gICAgfTtcbiAgICAvLyBHZXQgdmVyaWZpY2F0aW9uIGNvbmRpdGlvbnMgd2hpY2ggY2FuIGJlIGJvb2xlYW5zIG9yIGZ1bmN0aW9uczsgdGhlIHB1cnBvc2Ugb2YgdGhpcyBhc3luYy9hd2FpdFxuICAgIC8vIHN0cnVjdHVyZSBpcyB0byBhdm9pZCB1bm5lY2Vzc2FyaWx5IGV4ZWN1dGluZyBzdWJzZXF1ZW50IGZ1bmN0aW9ucyBpZiBwcmV2aW91cyBvbmVzIGZhaWwgaW4gdGhlXG4gICAgLy8gY29uZGl0aW9uYWwgc3RhdGVtZW50IGJlbG93LCBhcyBhIGRldmVsb3BlciBtYXkgZGVjaWRlIHRvIGV4ZWN1dGUgZXhwZW5zaXZlIG9wZXJhdGlvbnMgaW4gdGhlbVxuICAgIGNvbnN0IHZlcmlmeVVzZXJFbWFpbHMgPSBhc3luYyAoKSA9PiB0aGlzLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzID09PSB0cnVlIHx8ICh0eXBlb2YgdGhpcy5jb25maWcudmVyaWZ5VXNlckVtYWlscyA9PT0gJ2Z1bmN0aW9uJyAmJiBhd2FpdCBQcm9taXNlLnJlc29sdmUodGhpcy5jb25maWcudmVyaWZ5VXNlckVtYWlscyhyZXF1ZXN0KSkgPT09IHRydWUpO1xuICAgIGNvbnN0IHByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPSBhc3luYyAoKSA9PiB0aGlzLmNvbmZpZy5wcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID09PSB0cnVlIHx8ICh0eXBlb2YgdGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCA9PT0gJ2Z1bmN0aW9uJyAmJiBhd2FpdCBQcm9taXNlLnJlc29sdmUodGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbChyZXF1ZXN0KSkgPT09IHRydWUpO1xuICAgIC8vIElmIHZlcmlmaWNhdGlvbiBpcyByZXF1aXJlZFxuICAgIGlmIChhd2FpdCB2ZXJpZnlVc2VyRW1haWxzKCkgJiYgYXdhaXQgcHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCgpKSB7XG4gICAgICB0aGlzLnN0b3JhZ2UucmVqZWN0U2lnbnVwID0gdHJ1ZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNyZWF0ZVNlc3Npb25Ub2tlbiA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgLy8gY2xvdWQgaW5zdGFsbGF0aW9uSWQgZnJvbSBDbG91ZCBDb2RlLFxuICAvLyBuZXZlciBjcmVhdGUgc2Vzc2lvbiB0b2tlbnMgZnJvbSB0aGVyZS5cbiAgaWYgKHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCAmJiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQgPT09ICdjbG91ZCcpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA9PSBudWxsICYmIHRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmpvaW4oJywnKTtcbiAgfVxuXG4gIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IFJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uKHRoaXMuY29uZmlnLCB7XG4gICAgdXNlcklkOiB0aGlzLm9iamVjdElkKCksXG4gICAgY3JlYXRlZFdpdGg6IHtcbiAgICAgIGFjdGlvbjogdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA/ICdsb2dpbicgOiAnc2lnbnVwJyxcbiAgICAgIGF1dGhQcm92aWRlcjogdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciB8fCAncGFzc3dvcmQnLFxuICAgIH0sXG4gICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgfSk7XG5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2Uuc2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcbn07XG5cblJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uID0gZnVuY3Rpb24gKFxuICBjb25maWcsXG4gIHsgdXNlcklkLCBjcmVhdGVkV2l0aCwgaW5zdGFsbGF0aW9uSWQsIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSB9XG4pIHtcbiAgY29uc3QgdG9rZW4gPSAncjonICsgY3J5cHRvVXRpbHMubmV3VG9rZW4oKTtcbiAgY29uc3QgZXhwaXJlc0F0ID0gY29uZmlnLmdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCgpO1xuICBjb25zdCBzZXNzaW9uRGF0YSA9IHtcbiAgICBzZXNzaW9uVG9rZW46IHRva2VuLFxuICAgIHVzZXI6IHtcbiAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgb2JqZWN0SWQ6IHVzZXJJZCxcbiAgICB9LFxuICAgIGNyZWF0ZWRXaXRoLFxuICAgIGV4cGlyZXNBdDogUGFyc2UuX2VuY29kZShleHBpcmVzQXQpLFxuICB9O1xuXG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIHNlc3Npb25EYXRhLmluc3RhbGxhdGlvbklkID0gaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBPYmplY3QuYXNzaWduKHNlc3Npb25EYXRhLCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEpO1xuXG4gIHJldHVybiB7XG4gICAgc2Vzc2lvbkRhdGEsXG4gICAgY3JlYXRlU2Vzc2lvbjogKCkgPT5cbiAgICAgIG5ldyBSZXN0V3JpdGUoY29uZmlnLCBBdXRoLm1hc3Rlcihjb25maWcpLCAnX1Nlc3Npb24nLCBudWxsLCBzZXNzaW9uRGF0YSkuZXhlY3V0ZSgpLFxuICB9O1xufTtcblxuLy8gRGVsZXRlIGVtYWlsIHJlc2V0IHRva2VucyBpZiB1c2VyIGlzIGNoYW5naW5nIHBhc3N3b3JkIG9yIGVtYWlsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZWxldGVFbWFpbFJlc2V0VG9rZW5JZk5lZWRlZCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IHRoaXMucXVlcnkgPT09IG51bGwpIHtcbiAgICAvLyBudWxsIHF1ZXJ5IG1lYW5zIGNyZWF0ZVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgncGFzc3dvcmQnIGluIHRoaXMuZGF0YSB8fCAnZW1haWwnIGluIHRoaXMuZGF0YSkge1xuICAgIGNvbnN0IGFkZE9wcyA9IHtcbiAgICAgIF9wZXJpc2hhYmxlX3Rva2VuOiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgICBfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0OiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgfTtcbiAgICB0aGlzLmRhdGEgPSBPYmplY3QuYXNzaWduKHRoaXMuZGF0YSwgYWRkT3BzKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zID0gZnVuY3Rpb24gKCkge1xuICAvLyBPbmx5IGZvciBfU2Vzc2lvbiwgYW5kIGF0IGNyZWF0aW9uIHRpbWVcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9ICdfU2Vzc2lvbicgfHwgdGhpcy5xdWVyeSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEZXN0cm95IHRoZSBzZXNzaW9ucyBpbiAnQmFja2dyb3VuZCdcbiAgY29uc3QgeyB1c2VyLCBpbnN0YWxsYXRpb25JZCwgc2Vzc2lvblRva2VuIH0gPSB0aGlzLmRhdGE7XG4gIGlmICghdXNlciB8fCAhaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCF1c2VyLm9iamVjdElkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koXG4gICAgJ19TZXNzaW9uJyxcbiAgICB7XG4gICAgICB1c2VyLFxuICAgICAgaW5zdGFsbGF0aW9uSWQsXG4gICAgICBzZXNzaW9uVG9rZW46IHsgJG5lOiBzZXNzaW9uVG9rZW4gfSxcbiAgICB9LFxuICAgIHt9LFxuICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICk7XG59O1xuXG4vLyBIYW5kbGVzIGFueSBmb2xsb3d1cCBsb2dpY1xuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVGb2xsb3d1cCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSAmJiB0aGlzLmNvbmZpZy5yZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0KSB7XG4gICAgdmFyIHNlc3Npb25RdWVyeSA9IHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBkZWxldGUgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ107XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuZGVzdHJveSgnX1Nlc3Npb24nLCBzZXNzaW9uUXVlcnkpXG4gICAgICAudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnZ2VuZXJhdGVOZXdTZXNzaW9uJ107XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuKCkudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnc2VuZFZlcmlmaWNhdGlvbkVtYWlsJ107XG4gICAgLy8gRmlyZSBhbmQgZm9yZ2V0IVxuICAgIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNlbmRWZXJpZmljYXRpb25FbWFpbCh0aGlzLmRhdGEsIHsgYXV0aDogdGhpcy5hdXRoIH0pO1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcyk7XG4gIH1cbn07XG5cbi8vIEhhbmRsZXMgdGhlIF9TZXNzaW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gX1Nlc3Npb24gb2JqZWN0LlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVTZXNzaW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLmNsYXNzTmFtZSAhPT0gJ19TZXNzaW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLnVzZXIgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLCAnU2Vzc2lvbiB0b2tlbiByZXF1aXJlZC4nKTtcbiAgfVxuXG4gIC8vIFRPRE86IFZlcmlmeSBwcm9wZXIgZXJyb3IgdG8gdGhyb3dcbiAgaWYgKHRoaXMuZGF0YS5BQ0wpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0Nhbm5vdCBzZXQgJyArICdBQ0wgb24gYSBTZXNzaW9uLicpO1xuICB9XG5cbiAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICBpZiAodGhpcy5kYXRhLnVzZXIgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiB0aGlzLmRhdGEudXNlci5vYmplY3RJZCAhPSB0aGlzLmF1dGgudXNlci5pZCkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmRhdGEuc2Vzc2lvblRva2VuKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfVxuICAgIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgICB0aGlzLnF1ZXJ5ID0ge1xuICAgICAgICAkYW5kOiBbXG4gICAgICAgICAgdGhpcy5xdWVyeSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB1c2VyOiB7XG4gICAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgICAgICAgIG9iamVjdElkOiB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgY29uc3QgYWRkaXRpb25hbFNlc3Npb25EYXRhID0ge307XG4gICAgZm9yICh2YXIga2V5IGluIHRoaXMuZGF0YSkge1xuICAgICAgaWYgKGtleSA9PT0gJ29iamVjdElkJyB8fCBrZXkgPT09ICd1c2VyJykge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGFkZGl0aW9uYWxTZXNzaW9uRGF0YVtrZXldID0gdGhpcy5kYXRhW2tleV07XG4gICAgfVxuXG4gICAgY29uc3QgeyBzZXNzaW9uRGF0YSwgY3JlYXRlU2Vzc2lvbiB9ID0gUmVzdFdyaXRlLmNyZWF0ZVNlc3Npb24odGhpcy5jb25maWcsIHtcbiAgICAgIHVzZXJJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICBjcmVhdGVkV2l0aDoge1xuICAgICAgICBhY3Rpb246ICdjcmVhdGUnLFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSxcbiAgICB9KTtcblxuICAgIHJldHVybiBjcmVhdGVTZXNzaW9uKCkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmICghcmVzdWx0cy5yZXNwb25zZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLCAnRXJyb3IgY3JlYXRpbmcgc2Vzc2lvbi4nKTtcbiAgICAgIH1cbiAgICAgIHNlc3Npb25EYXRhWydvYmplY3RJZCddID0gcmVzdWx0cy5yZXNwb25zZVsnb2JqZWN0SWQnXTtcbiAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICBsb2NhdGlvbjogcmVzdWx0cy5sb2NhdGlvbixcbiAgICAgICAgcmVzcG9uc2U6IHNlc3Npb25EYXRhLFxuICAgICAgfTtcbiAgICB9KTtcbiAgfVxufTtcblxuLy8gSGFuZGxlcyB0aGUgX0luc3RhbGxhdGlvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIGluc3RhbGxhdGlvbiBvYmplY3QuXG4vLyBJZiBhbiBpbnN0YWxsYXRpb24gaXMgZm91bmQsIHRoaXMgY2FuIG11dGF0ZSB0aGlzLnF1ZXJ5IGFuZCB0dXJuIGEgY3JlYXRlXG4vLyBpbnRvIGFuIHVwZGF0ZS5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlSW5zdGFsbGF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLmNsYXNzTmFtZSAhPT0gJ19JbnN0YWxsYXRpb24nKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKFxuICAgICF0aGlzLnF1ZXJ5ICYmXG4gICAgIXRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAhdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIDEzNSxcbiAgICAgICdhdCBsZWFzdCBvbmUgSUQgZmllbGQgKGRldmljZVRva2VuLCBpbnN0YWxsYXRpb25JZCkgJyArICdtdXN0IGJlIHNwZWNpZmllZCBpbiB0aGlzIG9wZXJhdGlvbidcbiAgICApO1xuICB9XG5cbiAgLy8gSWYgdGhlIGRldmljZSB0b2tlbiBpcyA2NCBjaGFyYWN0ZXJzIGxvbmcsIHdlIGFzc3VtZSBpdCBpcyBmb3IgaU9TXG4gIC8vIGFuZCBsb3dlcmNhc2UgaXQuXG4gIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiYgdGhpcy5kYXRhLmRldmljZVRva2VuLmxlbmd0aCA9PSA2NCkge1xuICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiA9IHRoaXMuZGF0YS5kZXZpY2VUb2tlbi50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgLy8gV2UgbG93ZXJjYXNlIHRoZSBpbnN0YWxsYXRpb25JZCBpZiBwcmVzZW50XG4gIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQudG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIGxldCBpbnN0YWxsYXRpb25JZCA9IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZDtcblxuICAvLyBJZiBkYXRhLmluc3RhbGxhdGlvbklkIGlzIG5vdCBzZXQgYW5kIHdlJ3JlIG5vdCBtYXN0ZXIsIHdlIGNhbiBsb29rdXAgaW4gYXV0aFxuICBpZiAoIWluc3RhbGxhdGlvbklkICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBpbnN0YWxsYXRpb25JZCA9IGluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBVcGRhdGluZyBfSW5zdGFsbGF0aW9uIGJ1dCBub3QgdXBkYXRpbmcgYW55dGhpbmcgY3JpdGljYWxcbiAgaWYgKHRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiAhaW5zdGFsbGF0aW9uSWQgJiYgIXRoaXMuZGF0YS5kZXZpY2VUeXBlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICB2YXIgaWRNYXRjaDsgLy8gV2lsbCBiZSBhIG1hdGNoIG9uIGVpdGhlciBvYmplY3RJZCBvciBpbnN0YWxsYXRpb25JZFxuICB2YXIgb2JqZWN0SWRNYXRjaDtcbiAgdmFyIGluc3RhbGxhdGlvbklkTWF0Y2g7XG4gIHZhciBkZXZpY2VUb2tlbk1hdGNoZXMgPSBbXTtcblxuICAvLyBJbnN0ZWFkIG9mIGlzc3VpbmcgMyByZWFkcywgbGV0J3MgZG8gaXQgd2l0aCBvbmUgT1IuXG4gIGNvbnN0IG9yUXVlcmllcyA9IFtdO1xuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goe1xuICAgICAgb2JqZWN0SWQ6IHRoaXMucXVlcnkub2JqZWN0SWQsXG4gICAgfSk7XG4gIH1cbiAgaWYgKGluc3RhbGxhdGlvbklkKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goe1xuICAgICAgaW5zdGFsbGF0aW9uSWQ6IGluc3RhbGxhdGlvbklkLFxuICAgIH0pO1xuICB9XG4gIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7IGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gfSk7XG4gIH1cblxuICBpZiAob3JRdWVyaWVzLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgcHJvbWlzZSA9IHByb21pc2VcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICAgJ19JbnN0YWxsYXRpb24nLFxuICAgICAgICB7XG4gICAgICAgICAgJG9yOiBvclF1ZXJpZXMsXG4gICAgICAgIH0sXG4gICAgICAgIHt9XG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICByZXN1bHRzLmZvckVhY2gocmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCAmJiByZXN1bHQub2JqZWN0SWQgPT0gdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICAgIG9iamVjdElkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5pbnN0YWxsYXRpb25JZCA9PSBpbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIGluc3RhbGxhdGlvbklkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5kZXZpY2VUb2tlbiA9PSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgLy8gU2FuaXR5IGNoZWNrcyB3aGVuIHJ1bm5pbmcgYSBxdWVyeVxuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICBpZiAoIW9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQgZm9yIHVwZGF0ZS4nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAhPT0gb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM2LCAnaW5zdGFsbGF0aW9uSWQgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAhPT0gb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICAhb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM2LCAnZGV2aWNlVG9rZW4gbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICE9PSBvYmplY3RJZE1hdGNoLmRldmljZVR5cGVcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDEzNiwgJ2RldmljZVR5cGUgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIG9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgaWRNYXRjaCA9IG9iamVjdElkTWF0Y2g7XG4gICAgICB9XG5cbiAgICAgIGlmIChpbnN0YWxsYXRpb25JZCAmJiBpbnN0YWxsYXRpb25JZE1hdGNoKSB7XG4gICAgICAgIGlkTWF0Y2ggPSBpbnN0YWxsYXRpb25JZE1hdGNoO1xuICAgICAgfVxuICAgICAgLy8gbmVlZCB0byBzcGVjaWZ5IGRldmljZVR5cGUgb25seSBpZiBpdCdzIG5ld1xuICAgICAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJiAhaWRNYXRjaCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM1LCAnZGV2aWNlVHlwZSBtdXN0IGJlIHNwZWNpZmllZCBpbiB0aGlzIG9wZXJhdGlvbicpO1xuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgaWYgKCFpZE1hdGNoKSB7XG4gICAgICAgIGlmICghZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoID09IDEgJiZcbiAgICAgICAgICAoIWRldmljZVRva2VuTWF0Y2hlc1swXVsnaW5zdGFsbGF0aW9uSWQnXSB8fCAhaW5zdGFsbGF0aW9uSWQpXG4gICAgICAgICkge1xuICAgICAgICAgIC8vIFNpbmdsZSBtYXRjaCBvbiBkZXZpY2UgdG9rZW4gYnV0IG5vbmUgb24gaW5zdGFsbGF0aW9uSWQsIGFuZCBlaXRoZXJcbiAgICAgICAgICAvLyB0aGUgcGFzc2VkIG9iamVjdCBvciB0aGUgbWF0Y2ggaXMgbWlzc2luZyBhbiBpbnN0YWxsYXRpb25JZCwgc28gd2VcbiAgICAgICAgICAvLyBjYW4ganVzdCByZXR1cm4gdGhlIG1hdGNoLlxuICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgIH0gZWxzZSBpZiAoIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIDEzMixcbiAgICAgICAgICAgICdNdXN0IHNwZWNpZnkgaW5zdGFsbGF0aW9uSWQgd2hlbiBkZXZpY2VUb2tlbiAnICtcbiAgICAgICAgICAgICAgJ21hdGNoZXMgbXVsdGlwbGUgSW5zdGFsbGF0aW9uIG9iamVjdHMnXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBNdWx0aXBsZSBkZXZpY2UgdG9rZW4gbWF0Y2hlcyBhbmQgd2Ugc3BlY2lmaWVkIGFuIGluc3RhbGxhdGlvbiBJRCxcbiAgICAgICAgICAvLyBvciBhIHNpbmdsZSBtYXRjaCB3aGVyZSBib3RoIHRoZSBwYXNzZWQgYW5kIG1hdGNoaW5nIG9iamVjdHMgaGF2ZVxuICAgICAgICAgIC8vIGFuIGluc3RhbGxhdGlvbiBJRC4gVHJ5IGNsZWFuaW5nIG91dCBvbGQgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoXG4gICAgICAgICAgLy8gdGhlIGRldmljZVRva2VuLCBhbmQgcmV0dXJuIG5pbCB0byBzaWduYWwgdGhhdCBhIG5ldyBvYmplY3Qgc2hvdWxkXG4gICAgICAgICAgLy8gYmUgY3JlYXRlZC5cbiAgICAgICAgICB2YXIgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHtcbiAgICAgICAgICAgICAgJG5lOiBpbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfTtcbiAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KS5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgaWYgKGVyci5jb2RlID09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgLy8gbm8gZGVsZXRpb25zIHdlcmUgbWFkZS4gQ2FuIGJlIGlnbm9yZWQuXG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIHJldGhyb3cgdGhlIGVycm9yXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmICFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ10pIHtcbiAgICAgICAgICAvLyBFeGFjdGx5IG9uZSBkZXZpY2UgdG9rZW4gbWF0Y2ggYW5kIGl0IGRvZXNuJ3QgaGF2ZSBhbiBpbnN0YWxsYXRpb25cbiAgICAgICAgICAvLyBJRC4gVGhpcyBpcyB0aGUgb25lIGNhc2Ugd2hlcmUgd2Ugd2FudCB0byBtZXJnZSB3aXRoIHRoZSBleGlzdGluZ1xuICAgICAgICAgIC8vIG9iamVjdC5cbiAgICAgICAgICBjb25zdCBkZWxRdWVyeSA9IHsgb2JqZWN0SWQ6IGlkTWF0Y2gub2JqZWN0SWQgfTtcbiAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAgIC5kZXN0cm95KCdfSW5zdGFsbGF0aW9uJywgZGVsUXVlcnkpXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgICAgLy8gbm8gZGVsZXRpb25zIHdlcmUgbWFkZS4gQ2FuIGJlIGlnbm9yZWRcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgLy8gcmV0aHJvdyB0aGUgZXJyb3JcbiAgICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiBpZE1hdGNoLmRldmljZVRva2VuICE9IHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgICAgICAgICAgLy8gV2UncmUgc2V0dGluZyB0aGUgZGV2aWNlIHRva2VuIG9uIGFuIGV4aXN0aW5nIGluc3RhbGxhdGlvbiwgc29cbiAgICAgICAgICAgIC8vIHdlIHNob3VsZCB0cnkgY2xlYW5pbmcgb3V0IG9sZCBpbnN0YWxsYXRpb25zIHRoYXQgbWF0Y2ggdGhpc1xuICAgICAgICAgICAgLy8gZGV2aWNlIHRva2VuLlxuICAgICAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICAgIGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgLy8gV2UgaGF2ZSBhIHVuaXF1ZSBpbnN0YWxsIElkLCB1c2UgdGhhdCB0byBwcmVzZXJ2ZVxuICAgICAgICAgICAgLy8gdGhlIGludGVyZXN0aW5nIGluc3RhbGxhdGlvblxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgICAgICBkZWxRdWVyeVsnaW5zdGFsbGF0aW9uSWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgJiZcbiAgICAgICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgPT0gdGhpcy5kYXRhLm9iamVjdElkXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gd2UgcGFzc2VkIGFuIG9iamVjdElkLCBwcmVzZXJ2ZSB0aGF0IGluc3RhbGF0aW9uXG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydvYmplY3RJZCddID0ge1xuICAgICAgICAgICAgICAgICRuZTogaWRNYXRjaC5vYmplY3RJZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIFdoYXQgdG8gZG8gaGVyZT8gY2FuJ3QgcmVhbGx5IGNsZWFuIHVwIGV2ZXJ5dGhpbmcuLi5cbiAgICAgICAgICAgICAgcmV0dXJuIGlkTWF0Y2gub2JqZWN0SWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ2FwcElkZW50aWZpZXInXSA9IHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KS5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgICBpZiAoZXJyLmNvZGUgPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkLlxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAvLyByZXRocm93IHRoZSBlcnJvclxuICAgICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gSW4gbm9uLW1lcmdlIHNjZW5hcmlvcywganVzdCByZXR1cm4gdGhlIGluc3RhbGxhdGlvbiBtYXRjaCBpZFxuICAgICAgICAgIHJldHVybiBpZE1hdGNoLm9iamVjdElkO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSlcbiAgICAudGhlbihvYmpJZCA9PiB7XG4gICAgICBpZiAob2JqSWQpIHtcbiAgICAgICAgdGhpcy5xdWVyeSA9IHsgb2JqZWN0SWQ6IG9iaklkIH07XG4gICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuICAgICAgfVxuICAgICAgLy8gVE9ETzogVmFsaWRhdGUgb3BzIChhZGQvcmVtb3ZlIG9uIGNoYW5uZWxzLCAkaW5jIG9uIGJhZGdlLCBldGMuKVxuICAgIH0pO1xuICByZXR1cm4gcHJvbWlzZTtcbn07XG5cbi8vIElmIHdlIHNob3J0LWNpcmN1aXRlZCB0aGUgb2JqZWN0IHJlc3BvbnNlIC0gdGhlbiB3ZSBuZWVkIHRvIG1ha2Ugc3VyZSB3ZSBleHBhbmQgYWxsIHRoZSBmaWxlcyxcbi8vIHNpbmNlIHRoaXMgbWlnaHQgbm90IGhhdmUgYSBxdWVyeSwgbWVhbmluZyBpdCB3b24ndCByZXR1cm4gdGhlIGZ1bGwgcmVzdWx0IGJhY2suXG4vLyBUT0RPOiAobmx1dHNlbmtvKSBUaGlzIHNob3VsZCBkaWUgd2hlbiB3ZSBtb3ZlIHRvIHBlci1jbGFzcyBiYXNlZCBjb250cm9sbGVycyBvbiBfU2Vzc2lvbi9fVXNlclxuUmVzdFdyaXRlLnByb3RvdHlwZS5leHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgLy8gQ2hlY2sgd2hldGhlciB3ZSBoYXZlIGEgc2hvcnQtY2lyY3VpdGVkIHJlc3BvbnNlIC0gb25seSB0aGVuIHJ1biBleHBhbnNpb24uXG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICBhd2FpdCB0aGlzLmNvbmZpZy5maWxlc0NvbnRyb2xsZXIuZXhwYW5kRmlsZXNJbk9iamVjdCh0aGlzLmNvbmZpZywgdGhpcy5yZXNwb25zZS5yZXNwb25zZSk7XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuRGF0YWJhc2VPcGVyYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1JvbGUnKSB7XG4gICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnJvbGUuY2xlYXIoKTtcbiAgICBpZiAodGhpcy5jb25maWcubGl2ZVF1ZXJ5Q29udHJvbGxlcikge1xuICAgICAgdGhpcy5jb25maWcubGl2ZVF1ZXJ5Q29udHJvbGxlci5jbGVhckNhY2hlZFJvbGVzKHRoaXMuYXV0aC51c2VyKTtcbiAgICB9XG4gIH1cblxuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiYgdGhpcy5xdWVyeSAmJiB0aGlzLmF1dGguaXNVbmF1dGhlbnRpY2F0ZWQoKSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLlNFU1NJT05fTUlTU0lORyxcbiAgICAgIGBDYW5ub3QgbW9kaWZ5IHVzZXIgJHt0aGlzLnF1ZXJ5Lm9iamVjdElkfS5gXG4gICAgKTtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Qcm9kdWN0JyAmJiB0aGlzLmRhdGEuZG93bmxvYWQpIHtcbiAgICB0aGlzLmRhdGEuZG93bmxvYWROYW1lID0gdGhpcy5kYXRhLmRvd25sb2FkLm5hbWU7XG4gIH1cblxuICAvLyBUT0RPOiBBZGQgYmV0dGVyIGRldGVjdGlvbiBmb3IgQUNMLCBlbnN1cmluZyBhIHVzZXIgY2FuJ3QgYmUgbG9ja2VkIGZyb21cbiAgLy8gICAgICAgdGhlaXIgb3duIHVzZXIgcmVjb3JkLlxuICBpZiAodGhpcy5kYXRhLkFDTCAmJiB0aGlzLmRhdGEuQUNMWycqdW5yZXNvbHZlZCddKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfQUNMLCAnSW52YWxpZCBBQ0wuJyk7XG4gIH1cblxuICBpZiAodGhpcy5xdWVyeSkge1xuICAgIC8vIEZvcmNlIHRoZSB1c2VyIHRvIG5vdCBsb2Nrb3V0XG4gICAgLy8gTWF0Y2hlZCB3aXRoIHBhcnNlLmNvbVxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuQUNMICYmXG4gICAgICB0aGlzLmF1dGguaXNNYXN0ZXIgIT09IHRydWUgJiZcbiAgICAgIHRoaXMuYXV0aC5pc01haW50ZW5hbmNlICE9PSB0cnVlXG4gICAgKSB7XG4gICAgICB0aGlzLmRhdGEuQUNMW3RoaXMucXVlcnkub2JqZWN0SWRdID0geyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9O1xuICAgIH1cbiAgICAvLyB1cGRhdGUgcGFzc3dvcmQgdGltZXN0YW1wIGlmIHVzZXIgcGFzc3dvcmQgaXMgYmVpbmcgY2hhbmdlZFxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlXG4gICAgKSB7XG4gICAgICB0aGlzLmRhdGEuX3Bhc3N3b3JkX2NoYW5nZWRfYXQgPSBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKCkpO1xuICAgIH1cbiAgICAvLyBJZ25vcmUgY3JlYXRlZEF0IHdoZW4gdXBkYXRlXG4gICAgZGVsZXRlIHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG5cbiAgICBsZXQgZGVmZXIgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAvLyBpZiBwYXNzd29yZCBoaXN0b3J5IGlzIGVuYWJsZWQgdGhlbiBzYXZlIHRoZSBjdXJyZW50IHBhc3N3b3JkIHRvIGhpc3RvcnlcbiAgICBpZiAoXG4gICAgICB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICAgdGhpcy5kYXRhLl9oYXNoZWRfcGFzc3dvcmQgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnlcbiAgICApIHtcbiAgICAgIGRlZmVyID0gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgLmZpbmQoXG4gICAgICAgICAgJ19Vc2VyJyxcbiAgICAgICAgICB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgICB7IGtleXM6IFsnX3Bhc3N3b3JkX2hpc3RvcnknLCAnX2hhc2hlZF9wYXNzd29yZCddIH0sXG4gICAgICAgICAgQXV0aC5tYWludGVuYW5jZSh0aGlzLmNvbmZpZylcbiAgICAgICAgKVxuICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggIT0gMSkge1xuICAgICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCB1c2VyID0gcmVzdWx0c1swXTtcbiAgICAgICAgICBsZXQgb2xkUGFzc3dvcmRzID0gW107XG4gICAgICAgICAgaWYgKHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnkpIHtcbiAgICAgICAgICAgIG9sZFBhc3N3b3JkcyA9IF8udGFrZShcbiAgICAgICAgICAgICAgdXNlci5fcGFzc3dvcmRfaGlzdG9yeSxcbiAgICAgICAgICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5XG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvL24tMSBwYXNzd29yZHMgZ28gaW50byBoaXN0b3J5IGluY2x1ZGluZyBsYXN0IHBhc3N3b3JkXG4gICAgICAgICAgd2hpbGUgKFxuICAgICAgICAgICAgb2xkUGFzc3dvcmRzLmxlbmd0aCA+IE1hdGgubWF4KDAsIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDIpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICBvbGRQYXNzd29yZHMuc2hpZnQoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9oaXN0b3J5ID0gb2xkUGFzc3dvcmRzO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gZGVmZXIudGhlbigoKSA9PiB7XG4gICAgICAvLyBSdW4gYW4gdXBkYXRlXG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgLnVwZGF0ZShcbiAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICB0aGlzLnF1ZXJ5LFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICAgICAgKVxuICAgICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgICAgcmVzcG9uc2UudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgICAgdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShyZXNwb25zZSwgdGhpcy5kYXRhKTtcbiAgICAgICAgICB0aGlzLnJlc3BvbnNlID0geyByZXNwb25zZSB9O1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICAvLyBTZXQgdGhlIGRlZmF1bHQgQUNMIGFuZCBwYXNzd29yZCB0aW1lc3RhbXAgZm9yIHRoZSBuZXcgX1VzZXJcbiAgICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAgIHZhciBBQ0wgPSB0aGlzLmRhdGEuQUNMO1xuICAgICAgLy8gZGVmYXVsdCBwdWJsaWMgci93IEFDTFxuICAgICAgaWYgKCFBQ0wpIHtcbiAgICAgICAgQUNMID0ge307XG4gICAgICAgIGlmICghdGhpcy5jb25maWcuZW5mb3JjZVByaXZhdGVVc2Vycykge1xuICAgICAgICAgIEFDTFsnKiddID0geyByZWFkOiB0cnVlLCB3cml0ZTogZmFsc2UgfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gbWFrZSBzdXJlIHRoZSB1c2VyIGlzIG5vdCBsb2NrZWQgZG93blxuICAgICAgQUNMW3RoaXMuZGF0YS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgICB0aGlzLmRhdGEuQUNMID0gQUNMO1xuICAgICAgLy8gcGFzc3dvcmQgdGltZXN0YW1wIHRvIGJlIHVzZWQgd2hlbiBwYXNzd29yZCBleHBpcnkgcG9saWN5IGlzIGVuZm9yY2VkXG4gICAgICBpZiAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiYgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UpIHtcbiAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSdW4gYSBjcmVhdGVcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5jcmVhdGUodGhpcy5jbGFzc05hbWUsIHRoaXMuZGF0YSwgdGhpcy5ydW5PcHRpb25zLCBmYWxzZSwgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicgfHwgZXJyb3IuY29kZSAhPT0gUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBRdWljayBjaGVjaywgaWYgd2Ugd2VyZSBhYmxlIHRvIGluZmVyIHRoZSBkdXBsaWNhdGVkIGZpZWxkIG5hbWVcbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnVzZXJJbmZvICYmIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICd1c2VybmFtZScpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnVzZXJJbmZvICYmIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICdlbWFpbCcpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB0aGlzIHdhcyBhIGZhaWxlZCB1c2VyIGNyZWF0aW9uIGR1ZSB0byB1c2VybmFtZSBvciBlbWFpbCBhbHJlYWR5IHRha2VuLCB3ZSBuZWVkIHRvXG4gICAgICAgIC8vIGNoZWNrIHdoZXRoZXIgaXQgd2FzIHVzZXJuYW1lIG9yIGVtYWlsIGFuZCByZXR1cm4gdGhlIGFwcHJvcHJpYXRlIGVycm9yLlxuICAgICAgICAvLyBGYWxsYmFjayB0byB0aGUgb3JpZ2luYWwgbWV0aG9kXG4gICAgICAgIC8vIFRPRE86IFNlZSBpZiB3ZSBjYW4gbGF0ZXIgZG8gdGhpcyB3aXRob3V0IGFkZGl0aW9uYWwgcXVlcmllcyBieSB1c2luZyBuYW1lZCBpbmRleGVzLlxuICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAuZmluZChcbiAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB1c2VybmFtZTogdGhpcy5kYXRhLnVzZXJuYW1lLFxuICAgICAgICAgICAgICBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHsgbGltaXQ6IDEgfVxuICAgICAgICAgIClcbiAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOLFxuICAgICAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgeyBlbWFpbDogdGhpcy5kYXRhLmVtYWlsLCBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9IH0sXG4gICAgICAgICAgICAgIHsgbGltaXQ6IDEgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgcmVzcG9uc2Uub2JqZWN0SWQgPSB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gICAgICAgIHJlc3BvbnNlLmNyZWF0ZWRBdCA9IHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG5cbiAgICAgICAgaWYgKHRoaXMucmVzcG9uc2VTaG91bGRIYXZlVXNlcm5hbWUpIHtcbiAgICAgICAgICByZXNwb25zZS51c2VybmFtZSA9IHRoaXMuZGF0YS51c2VybmFtZTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKHJlc3BvbnNlLCB0aGlzLmRhdGEpO1xuICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICAgIHJlc3BvbnNlLFxuICAgICAgICAgIGxvY2F0aW9uOiB0aGlzLmxvY2F0aW9uKCksXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgfVxufTtcblxuLy8gUmV0dXJucyBub3RoaW5nIC0gZG9lc24ndCB3YWl0IGZvciB0aGUgdHJpZ2dlci5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQWZ0ZXJTYXZlVHJpZ2dlciA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLnJlc3BvbnNlIHx8ICF0aGlzLnJlc3BvbnNlLnJlc3BvbnNlIHx8IHRoaXMucnVuT3B0aW9ucy5tYW55KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYWZ0ZXJTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBjb25zdCBoYXNBZnRlclNhdmVIb29rID0gdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICApO1xuICBjb25zdCBoYXNMaXZlUXVlcnkgPSB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLmhhc0xpdmVRdWVyeSh0aGlzLmNsYXNzTmFtZSk7XG4gIGlmICghaGFzQWZ0ZXJTYXZlSG9vayAmJiAhaGFzTGl2ZVF1ZXJ5KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICB1cGRhdGVkT2JqZWN0Ll9oYW5kbGVTYXZlUmVzcG9uc2UodGhpcy5yZXNwb25zZS5yZXNwb25zZSwgdGhpcy5yZXNwb25zZS5zdGF0dXMgfHwgMjAwKTtcblxuICBpZiAoaGFzTGl2ZVF1ZXJ5KSB7XG4gICAgdGhpcy5jb25maWcuZGF0YWJhc2UubG9hZFNjaGVtYSgpLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICAvLyBOb3RpZnkgTGl2ZVF1ZXJ5U2VydmVyIGlmIHBvc3NpYmxlXG4gICAgICBjb25zdCBwZXJtcyA9IHNjaGVtYUNvbnRyb2xsZXIuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lKTtcbiAgICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIub25BZnRlclNhdmUoXG4gICAgICAgIHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgcGVybXNcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cbiAgaWYgKCFoYXNBZnRlclNhdmVIb29rKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFJ1biBhZnRlclNhdmUgdHJpZ2dlclxuICByZXR1cm4gdHJpZ2dlcnNcbiAgICAubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLFxuICAgICAgdGhpcy5hdXRoLFxuICAgICAgdXBkYXRlZE9iamVjdCxcbiAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLmNvbnRleHRcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgIGNvbnN0IGpzb25SZXR1cm5lZCA9IHJlc3VsdCAmJiAhcmVzdWx0Ll90b0Z1bGxKU09OO1xuICAgICAgaWYgKGpzb25SZXR1cm5lZCkge1xuICAgICAgICB0aGlzLnBlbmRpbmdPcHMub3BlcmF0aW9ucyA9IHt9O1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlID0gcmVzdWx0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZSA9IHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEoXG4gICAgICAgICAgKHJlc3VsdCB8fCB1cGRhdGVkT2JqZWN0KS50b0pTT04oKSxcbiAgICAgICAgICB0aGlzLmRhdGFcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBsb2dnZXIud2FybignYWZ0ZXJTYXZlIGNhdWdodCBhbiBlcnJvcicsIGVycik7XG4gICAgfSk7XG59O1xuXG4vLyBBIGhlbHBlciB0byBmaWd1cmUgb3V0IHdoYXQgbG9jYXRpb24gdGhpcyBvcGVyYXRpb24gaGFwcGVucyBhdC5cblJlc3RXcml0ZS5wcm90b3R5cGUubG9jYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBtaWRkbGUgPSB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyA/ICcvdXNlcnMvJyA6ICcvY2xhc3Nlcy8nICsgdGhpcy5jbGFzc05hbWUgKyAnLyc7XG4gIGNvbnN0IG1vdW50ID0gdGhpcy5jb25maWcubW91bnQgfHwgdGhpcy5jb25maWcuc2VydmVyVVJMO1xuICByZXR1cm4gbW91bnQgKyBtaWRkbGUgKyB0aGlzLmRhdGEub2JqZWN0SWQ7XG59O1xuXG4vLyBBIGhlbHBlciB0byBnZXQgdGhlIG9iamVjdCBpZCBmb3IgdGhpcyBvcGVyYXRpb24uXG4vLyBCZWNhdXNlIGl0IGNvdWxkIGJlIGVpdGhlciBvbiB0aGUgcXVlcnkgb3Igb24gdGhlIGRhdGFcblJlc3RXcml0ZS5wcm90b3R5cGUub2JqZWN0SWQgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLmRhdGEub2JqZWN0SWQgfHwgdGhpcy5xdWVyeS5vYmplY3RJZDtcbn07XG5cbi8vIFJldHVybnMgYSBjb3B5IG9mIHRoZSBkYXRhIGFuZCBkZWxldGUgYmFkIGtleXMgKF9hdXRoX2RhdGEsIF9oYXNoZWRfcGFzc3dvcmQuLi4pXG5SZXN0V3JpdGUucHJvdG90eXBlLnNhbml0aXplZERhdGEgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IGRhdGEgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLnJlZHVjZSgoZGF0YSwga2V5KSA9PiB7XG4gICAgLy8gUmVnZXhwIGNvbWVzIGZyb20gUGFyc2UuT2JqZWN0LnByb3RvdHlwZS52YWxpZGF0ZVxuICAgIGlmICghL15bQS1aYS16XVswLTlBLVphLXpfXSokLy50ZXN0KGtleSkpIHtcbiAgICAgIGRlbGV0ZSBkYXRhW2tleV07XG4gICAgfVxuICAgIHJldHVybiBkYXRhO1xuICB9LCBkZWVwY29weSh0aGlzLmRhdGEpKTtcbiAgcmV0dXJuIFBhcnNlLl9kZWNvZGUodW5kZWZpbmVkLCBkYXRhKTtcbn07XG5cbi8vIFJldHVybnMgYW4gdXBkYXRlZCBjb3B5IG9mIHRoZSBvYmplY3RcblJlc3RXcml0ZS5wcm90b3R5cGUuYnVpbGRQYXJzZU9iamVjdHMgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IGV4dHJhRGF0YSA9IHsgY2xhc3NOYW1lOiB0aGlzLmNsYXNzTmFtZSwgb2JqZWN0SWQ6IHRoaXMucXVlcnk/Lm9iamVjdElkIH07XG4gIGxldCBvcmlnaW5hbE9iamVjdDtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIG9yaWdpbmFsT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgfVxuXG4gIGNvbnN0IGNsYXNzTmFtZSA9IFBhcnNlLk9iamVjdC5mcm9tSlNPTihleHRyYURhdGEpO1xuICBjb25zdCByZWFkT25seUF0dHJpYnV0ZXMgPSBjbGFzc05hbWUuY29uc3RydWN0b3IucmVhZE9ubHlBdHRyaWJ1dGVzXG4gICAgPyBjbGFzc05hbWUuY29uc3RydWN0b3IucmVhZE9ubHlBdHRyaWJ1dGVzKClcbiAgICA6IFtdO1xuICBpZiAoIXRoaXMub3JpZ2luYWxEYXRhKSB7XG4gICAgZm9yIChjb25zdCBhdHRyaWJ1dGUgb2YgcmVhZE9ubHlBdHRyaWJ1dGVzKSB7XG4gICAgICBleHRyYURhdGFbYXR0cmlidXRlXSA9IHRoaXMuZGF0YVthdHRyaWJ1dGVdO1xuICAgIH1cbiAgfVxuICBjb25zdCB1cGRhdGVkT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgT2JqZWN0LmtleXModGhpcy5kYXRhKS5yZWR1Y2UoZnVuY3Rpb24gKGRhdGEsIGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgaWYgKHR5cGVvZiBkYXRhW2tleV0uX19vcCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKCFyZWFkT25seUF0dHJpYnV0ZXMuaW5jbHVkZXMoa2V5KSkge1xuICAgICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KGtleSwgZGF0YVtrZXldKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gc3ViZG9jdW1lbnQga2V5IHdpdGggZG90IG5vdGF0aW9uIHsgJ3gueSc6IHYgfSA9PiB7ICd4JzogeyAneScgOiB2IH0gfSlcbiAgICAgICAgY29uc3Qgc3BsaXR0ZWRLZXkgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgICAgY29uc3QgcGFyZW50UHJvcCA9IHNwbGl0dGVkS2V5WzBdO1xuICAgICAgICBsZXQgcGFyZW50VmFsID0gdXBkYXRlZE9iamVjdC5nZXQocGFyZW50UHJvcCk7XG4gICAgICAgIGlmICh0eXBlb2YgcGFyZW50VmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICAgIHBhcmVudFZhbCA9IHt9O1xuICAgICAgICB9XG4gICAgICAgIHBhcmVudFZhbFtzcGxpdHRlZEtleVsxXV0gPSBkYXRhW2tleV07XG4gICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KHBhcmVudFByb3AsIHBhcmVudFZhbCk7XG4gICAgICB9XG4gICAgICBkZWxldGUgZGF0YVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfSwgZGVlcGNvcHkodGhpcy5kYXRhKSk7XG5cbiAgY29uc3Qgc2FuaXRpemVkID0gdGhpcy5zYW5pdGl6ZWREYXRhKCk7XG4gIGZvciAoY29uc3QgYXR0cmlidXRlIG9mIHJlYWRPbmx5QXR0cmlidXRlcykge1xuICAgIGRlbGV0ZSBzYW5pdGl6ZWRbYXR0cmlidXRlXTtcbiAgfVxuICB1cGRhdGVkT2JqZWN0LnNldChzYW5pdGl6ZWQpO1xuICByZXR1cm4geyB1cGRhdGVkT2JqZWN0LCBvcmlnaW5hbE9iamVjdCB9O1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jbGVhblVzZXJBdXRoRGF0YSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSAmJiB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIGNvbnN0IHVzZXIgPSB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlO1xuICAgIGlmICh1c2VyLmF1dGhEYXRhKSB7XG4gICAgICBPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgICAgaWYgKHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdID09PSBudWxsKSB7XG4gICAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGlmIChPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5sZW5ndGggPT0gMCkge1xuICAgICAgICBkZWxldGUgdXNlci5hdXRoRGF0YTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEgPSBmdW5jdGlvbiAocmVzcG9uc2UsIGRhdGEpIHtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKHRoaXMucGVuZGluZ09wcy5pZGVudGlmaWVyKTtcbiAgZm9yIChjb25zdCBrZXkgaW4gdGhpcy5wZW5kaW5nT3BzLm9wZXJhdGlvbnMpIHtcbiAgICBpZiAoIXBlbmRpbmdba2V5XSkge1xuICAgICAgZGF0YVtrZXldID0gdGhpcy5vcmlnaW5hbERhdGEgPyB0aGlzLm9yaWdpbmFsRGF0YVtrZXldIDogeyBfX29wOiAnRGVsZXRlJyB9O1xuICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIucHVzaChrZXkpO1xuICAgIH1cbiAgfVxuICBjb25zdCBza2lwS2V5cyA9IFsuLi4ocmVxdWlyZWRDb2x1bW5zLnJlYWRbdGhpcy5jbGFzc05hbWVdIHx8IFtdKV07XG4gIGlmICghdGhpcy5xdWVyeSkge1xuICAgIHNraXBLZXlzLnB1c2goJ29iamVjdElkJywgJ2NyZWF0ZWRBdCcpO1xuICB9IGVsc2Uge1xuICAgIHNraXBLZXlzLnB1c2goJ3VwZGF0ZWRBdCcpO1xuICAgIGRlbGV0ZSByZXNwb25zZS5vYmplY3RJZDtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBpbiByZXNwb25zZSkge1xuICAgIGlmIChza2lwS2V5cy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgdmFsdWUgPSByZXNwb25zZVtrZXldO1xuICAgIGlmIChcbiAgICAgIHZhbHVlID09IG51bGwgfHxcbiAgICAgICh2YWx1ZS5fX3R5cGUgJiYgdmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKGRhdGFba2V5XSwgdmFsdWUpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKCh0aGlzLm9yaWdpbmFsRGF0YSB8fCB7fSlba2V5XSwgdmFsdWUpXG4gICAgKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2Vba2V5XTtcbiAgICB9XG4gIH1cbiAgaWYgKF8uaXNFbXB0eSh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlcikpIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgY2xpZW50U3VwcG9ydHNEZWxldGUgPSBDbGllbnRTREsuc3VwcG9ydHNGb3J3YXJkRGVsZXRlKHRoaXMuY2xpZW50U0RLKTtcbiAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGNvbnN0IGRhdGFWYWx1ZSA9IGRhdGFbZmllbGROYW1lXTtcblxuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3BvbnNlLCBmaWVsZE5hbWUpKSB7XG4gICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgIH1cblxuICAgIC8vIFN0cmlwcyBvcGVyYXRpb25zIGZyb20gcmVzcG9uc2VzXG4gICAgaWYgKHJlc3BvbnNlW2ZpZWxkTmFtZV0gJiYgcmVzcG9uc2VbZmllbGROYW1lXS5fX29wKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2VbZmllbGROYW1lXTtcbiAgICAgIGlmIChjbGllbnRTdXBwb3J0c0RlbGV0ZSAmJiBkYXRhVmFsdWUuX19vcCA9PSAnRGVsZXRlJykge1xuICAgICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiByZXNwb25zZTtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IFJlc3RXcml0ZTtcbm1vZHVsZS5leHBvcnRzID0gUmVzdFdyaXRlO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFlQSxJQUFBQSxVQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRSxPQUFBLEdBQUFILHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRyxpQkFBQSxHQUFBSCxPQUFBO0FBQWlFLFNBQUFELHVCQUFBSyxDQUFBLFdBQUFBLENBQUEsSUFBQUEsQ0FBQSxDQUFBQyxVQUFBLEdBQUFELENBQUEsS0FBQUUsT0FBQSxFQUFBRixDQUFBO0FBQUEsU0FBQUcsUUFBQUgsQ0FBQSxFQUFBSSxDQUFBLFFBQUFDLENBQUEsR0FBQUMsTUFBQSxDQUFBQyxJQUFBLENBQUFQLENBQUEsT0FBQU0sTUFBQSxDQUFBRSxxQkFBQSxRQUFBQyxDQUFBLEdBQUFILE1BQUEsQ0FBQUUscUJBQUEsQ0FBQVIsQ0FBQSxHQUFBSSxDQUFBLEtBQUFLLENBQUEsR0FBQUEsQ0FBQSxDQUFBQyxNQUFBLFdBQUFOLENBQUEsV0FBQUUsTUFBQSxDQUFBSyx3QkFBQSxDQUFBWCxDQUFBLEVBQUFJLENBQUEsRUFBQVEsVUFBQSxPQUFBUCxDQUFBLENBQUFRLElBQUEsQ0FBQUMsS0FB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
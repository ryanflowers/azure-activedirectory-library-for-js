﻿//----------------------------------------------------------------------
// AdalJS v1.0.9
// @preserve Copyright (c) Microsoft Open Technologies, Inc.
// All Rights Reserved
// Apache License 2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//----------------------------------------------------------------------
'use strict';

// node.js usage for tests
var Logging = {
    level: 0,
    log: function () { }
};

var AuthenticationContext;
if (typeof module !== 'undefined' && module.exports) {
    module.exports.inject = function (conf) {
        return new AuthenticationContext(conf);
    };
}

/**
 * Config information
 * @public
 * @class Config
 * @property {tenant}          Your target tenant
 * @property {clientId}        Identifier assigned to your app by Azure Active Directory
 * @property {redirectUri}     Endpoint at which you expect to receive tokens
 * @property {instance}        Azure Active Directory Instance(default:https://login.microsoftonline.com/)
 * @property {endpoints}       Collection of {Endpoint-ResourceId} used for autmatically attaching tokens in webApi calls
 */

/**
 * User information from idtoken.
 *  @class User
 *  @property {string} userName - username assigned from upn or email.
 *  @property {object} profile - properties parsed from idtoken.
 */

/**
 * Creates a new AuthenticationContext object.
 * @constructor
 * @param {object}  config               Configuration options for AuthenticationContext
 *
 **/
AuthenticationContext = function (config) {
    /**
     * Enum for request type
     * @enum {string}
     */
    this.REQUEST_TYPE = {
        LOGIN: 'LOGIN',
        RENEW_TOKEN: 'RENEW_TOKEN',
        UNKNOWN: 'UNKNOWN'
    };

    /**
     * Enum for storage constants
     * @enum {string}
     */
    this.CONSTANTS = {
        ACCESS_TOKEN: 'access_token',
        EXPIRES_IN: 'expires_in',
        ID_TOKEN: 'id_token',
        ERROR_DESCRIPTION: 'error_description',
        SESSION_STATE: 'session_state',
        STORAGE: {
            TOKEN_KEYS: 'adal.token.keys',
            ACCESS_TOKEN_KEY: 'adal.access.token.key',
            EXPIRATION_KEY: 'adal.expiration.key',
            START_PAGE: 'adal.start.page',
            START_PAGE_PARAMS: 'adal.start.page.params',
            STATE_LOGIN: 'adal.state.login',
            STATE_RENEW: 'adal.state.renew',
            STATE_RENEW_RESOURCE: 'adal.state.renew.resource',
            NONCE_IDTOKEN: 'adal.nonce.idtoken',
            SESSION_STATE: 'adal.session.state',
            USERNAME: 'adal.username',
            IDTOKEN: 'adal.idtoken',
            ERROR: 'adal.error',
            ERROR_DESCRIPTION: 'adal.error.description',
            LOGIN_REQUEST: 'adal.login.request',
            LOGIN_ERROR: 'adal.login.error'
        },
        RESOURCE_DELIMETER: '|',
        ERR_MESSAGES: {
            NO_TOKEN: 'User is not authorized'
        },
        LOADFRAME_TIMEOUT: '15000',
        LOADFRAME_PENDING: 'pending',
        LOADFRAME_TIMEOUT_CODE: 'AADSTSTimeout',
        LOGGING_LEVEL: {
            ERROR: 0,
            WARN: 1,
            INFO: 2,
            VERBOSE: 3
        },
        LEVEL_STRING_MAP: {
            0: 'ERROR:',
            1: 'WARNING:',
            2: 'INFO:',
            3: 'VERBOSE:'
        }
    };

    if (AuthenticationContext.prototype._singletonInstance) {
        return AuthenticationContext.prototype._singletonInstance;
    }
    AuthenticationContext.prototype._singletonInstance = this;

    // public
    this.instance = 'https://login.microsoftonline.com/';
    this.config = {};
    this.callback = null;
    this.popUp = false;

    // private
    this._user = null;
    this._activeRenewals = {};
    this._loginInProgress = false;
    this._renewStates = [];

    window.loadframeStatus = {};
    window.callBackMappedToRenewStates = {};
    window.callBacksMappedToRenewStates = {};

    // validate before constructor assignments
    if (config.displayCall && typeof config.displayCall !== 'function') {
        throw new Error('displayCall is not a function');
    }

    if (!config.clientId) {
        throw new Error('clientId is required');
    }

    if (!config.correlationId) {
        config.correlationId = this._guid();
    }

    this.config = this._cloneConfig(config);

    // App can request idtoken for itself using clientid as resource
    if (!this.config.loginResource) {
        this.config.loginResource = this.config.clientId;
    }

    if (!this.config.redirectUri) {
        this.config.redirectUri = window.location.href;
    }
};

/**
 * Gets initial Idtoken for the app backend
 * Saves the resulting Idtoken in localStorage.
 */
AuthenticationContext.prototype.login = function () {
    // Token is not present and user needs to login
    var expectedState = this._guid();
    this.config.state = expectedState;
    this._idTokenNonce = this._guid();
    this.verbose('Expected state: ' + expectedState + ' startPage:' + window.location);
    this._saveItem(this.CONSTANTS.STORAGE.LOGIN_REQUEST, window.location);
    this._saveItem(this.CONSTANTS.STORAGE.LOGIN_ERROR, '');
    this._saveItem(this.CONSTANTS.STORAGE.STATE_LOGIN, expectedState);
    this._saveItem(this.CONSTANTS.STORAGE.NONCE_IDTOKEN, this._idTokenNonce);
    this._saveItem(this.CONSTANTS.STORAGE.ERROR, '');
    this._saveItem(this.CONSTANTS.STORAGE.ERROR_DESCRIPTION, '');

    var urlNavigate = this._getNavigateUrl('id_token', null) + '&nonce=' + encodeURIComponent(this._idTokenNonce);
    urlNavigate = this._getUrlWithGlobalResource(urlNavigate, this.config.globalResource);

    // don't add domain_hint twice if user provided it in the extraQueryParameter value
    if (!this._urlContainsQueryStringParameter("domain_hint", urlNavigate)) {
        urlNavigate += '&domain_hint=' + encodeURIComponent(this._getDomainHint());
    }

    this.frameCallInProgress = false;
    this._loginInProgress = true;
    this.event('adalLogin', {resource: this.config.clientId});
    if (this.config.displayCall) {
        // User defined way of handling the navigation
        this.config.displayCall(urlNavigate);
    } else {
        this.promptUser(urlNavigate);
    }
    // callback from redirected page will receive fragment. It needs to call oauth2Callback
};

/**
 * Appends the provided resource to the url as qsp. As well as requesting token as the request type. This will load
 * the resources security policy in the response created.
 * @param url - The url to append to.
 * @param resource - The resource to append.
 * @returns {string} - The altered url
 * @private
 */
AuthenticationContext.prototype._getUrlWithGlobalResource = function (url, resource) {
    if(resource) {
        return url.replace('=id_token', '=token id_token') + '&resource=' + resource;
    }
    else{
        return url;
    }
};

AuthenticationContext.prototype.loginInProgress = function () {
    return this._loginInProgress;
};

AuthenticationContext.prototype._hasResource = function (key) {
    var keys = this._getItem(this.CONSTANTS.STORAGE.TOKEN_KEYS);
    return keys && !this._isEmpty(keys) && (keys.indexOf(key + this.CONSTANTS.RESOURCE_DELIMETER) > -1);
};

/**
 * Gets token for the specified resource from local storage cache
 * @param {string}   resource A URI that identifies the resource for which the token is valid.
 * @returns {string} token if exists and not expired or null
 */
AuthenticationContext.prototype.getCachedToken = function (resource) {
    if (!this._hasResource(resource)) {
        return null;
    }

    var token = this._getItem(this.CONSTANTS.STORAGE.ACCESS_TOKEN_KEY + resource);
    var expired = this._getItem(this.CONSTANTS.STORAGE.EXPIRATION_KEY + resource);

    // If expiration is within offset, it will force renew
    var offset = this.config.expireOffsetSeconds || 120;

    if (expired && (expired > this._now() + offset)) {
        return token;
    } else {
        if(expired && expired > 0) {
            var tokenExpiresIn = expired - this._now();
            this.info('Token cleared from local storage for resource:' + resource + ' expires in:' + tokenExpiresIn);
            this.event('adalCacheCleared', {resource: resource, expiresIn: tokenExpiresIn});
        }

        this._saveItem(this.CONSTANTS.STORAGE.ACCESS_TOKEN_KEY + resource, '');
        this._saveItem(this.CONSTANTS.STORAGE.EXPIRATION_KEY + resource, 0);
        return null;
    }
};

/**
 * Retrieves and parse idToken from localstorage
 * @returns {User} user object
 */
AuthenticationContext.prototype.getCachedUser = function () {
    if (this._user) {
        return this._user;
    }

    var idtoken = this._getItem(this.CONSTANTS.STORAGE.IDTOKEN);
    this._user = this._createUser(idtoken);
    return this._user;
};

AuthenticationContext.prototype.registerCallback = function (expectedState, resource, callback) {
    this._activeRenewals[resource] = expectedState;
    if (!window.callBacksMappedToRenewStates[expectedState]) {
        window.callBacksMappedToRenewStates[expectedState] = [];
    }
    var self = this;
    window.callBacksMappedToRenewStates[expectedState].push(callback);
    if (!window.callBackMappedToRenewStates[expectedState]) {
        window.callBackMappedToRenewStates[expectedState] = function (message, token) {
            for (var i = 0; i < window.callBacksMappedToRenewStates[expectedState].length; ++i) {
                window.callBacksMappedToRenewStates[expectedState][i](message, token);
            }
            self._activeRenewals[resource] = null;
            window.callBacksMappedToRenewStates[expectedState] = null;
            window.callBackMappedToRenewStates[expectedState] = null;
        };
    }
};

// var errorResponse = {error:'', errorDescription:''};
// var token = 'string token';
// callback(errorResponse, token)
// with callback
/**
 * Acquires access token with hidden iframe
 * @param {string}   resource  ResourceUri identifying the target resource
 * @returns {string} access token if request is successfull
 */
AuthenticationContext.prototype._renewToken = function (resource, callback) {
    // use iframe to try refresh token
    // use given resource to create new authz url
    this.info('renewToken is called for resource:' + resource);
    var frameHandle = this._addAdalFrame('adalRenewFrame' + resource);
    var expectedState = this._guid() + '|' + resource;
    this._idTokenNonce = this._guid();
    this.config.state = expectedState;
    // renew happens in iframe, so it keeps javascript context
    this._renewStates.push(expectedState);

    this.verbose('Renew token Expected state: ' + expectedState);
    var urlNavigate = this._getNavigateUrl('token', resource) + '&prompt=none&login_hint=' + encodeURIComponent(this._user.userName);

    // don't add domain_hint twice if user provided it in the extraQueryParameter value
    if (!this._urlContainsQueryStringParameter("domain_hint", urlNavigate)) {
        urlNavigate += '&domain_hint=' + encodeURIComponent(this._getDomainHint());
    }

    urlNavigate += '&nonce=' + encodeURIComponent(this._idTokenNonce);
    this.callback = callback;
    this.registerCallback(expectedState, resource, callback);
    this.idTokenNonce = null;
    this.verbose('Navigate to:' + urlNavigate);
    this._saveItem(this.CONSTANTS.STORAGE.LOGIN_REQUEST, '');
    frameHandle.src = 'about:blank';
    this._loadFrameTimeout(urlNavigate, 'adalRenewFrame' + resource, resource, this.CONSTANTS.LOADFRAME_TIMEOUT);
};

AuthenticationContext.prototype._renewIdToken = function (callback) {
    // use iframe to try refresh token
    this.info('renewIdToken is called');
    var frameHandle = this._addAdalFrame('adalIdTokenFrame');
    var expectedState = this._guid() + '|' + this.config.clientId;
    this._idTokenNonce = this._guid();
    this._saveItem(this.CONSTANTS.STORAGE.NONCE_IDTOKEN, this._idTokenNonce);
    this.config.state = expectedState;
    // renew happens in iframe, so it keeps javascript context
    this._renewStates.push(expectedState);

    this.verbose('Renew Idtoken Expected state: ' + expectedState);
    var urlNavigate = this._getNavigateUrl('id_token', null) + '&prompt=none&login_hint=' + encodeURIComponent(this._user.userName);

    // don't add domain_hint twice if user provided it in the extraQueryParameter value
    if (!this._urlContainsQueryStringParameter("domain_hint", urlNavigate)) {
        urlNavigate += '&domain_hint=' + encodeURIComponent(this._getDomainHint());
    }

    urlNavigate += '&nonce=' + encodeURIComponent(this._idTokenNonce);
    this.registerCallback(expectedState, this.config.clientId, callback);
    this.idTokenNonce = null;
    this.verbose('Navigate to:' + urlNavigate);
    this._saveItem(this.CONSTANTS.STORAGE.LOGIN_REQUEST, '');
    frameHandle.src = 'about:blank';
    this._loadFrameTimeout(urlNavigate, 'adalIdTokenFrame', this.config.clientId, this.CONSTANTS.LOADFRAME_TIMEOUT);
};

AuthenticationContext.prototype._urlContainsQueryStringParameter = function (name, url) {
    // regex to detect pattern of a ? or & followed by the name parameter and an equals character
    var regex = new RegExp("[\\?&]" + name + "=");
    return regex.test(url);
};

/* Calling _loadFrame but with a timeout to signal failure in loadframeStatus. Frames are left
 * hanging when network errors occur.
 * https://github.com/AzureAD/azure-activedirectory-library-for-js/issues/250.
 * */
AuthenticationContext.prototype._loadFrameTimeout = function (urlNavigation, frameName, resource, timeout) {
    //set iframe session to pending
    this.info('Set loading state to pending for: ' + resource);
    window.loadframeStatus[resource] = this.CONSTANTS.LOADFRAME_PENDING;
    this.event('adalIframePending', {resource: resource});

    this._loadFrame(urlNavigation, frameName);

    var timeoutDuration = timeout/1000;
    var resourceSaved = resource;
    var self = this;

    setTimeout(function () {
        if (window.loadframeStatus[resource] === self.CONSTANTS.LOADFRAME_PENDING) {
            //fail the iframe session if it's in pending state
            self.error('Loading frame has timed out after: ' + timeoutDuration + ' seconds for resource ' + resourceSaved);

            var expectedState = self._activeRenewals[resource];
            if (expectedState && window.callBackMappedToRenewStates[expectedState]) {
                window.callBackMappedToRenewStates[expectedState](self.CONSTANTS.LOADFRAME_TIMEOUT_CODE + ' due to timeout', null);
            }

            self.error('Removing iframe session tracking for resource:' + resource);
            self.event('adalIframeCleared', {resource: resource, reason: 'timeout'});
            delete window.parent.loadframeStatus[resource];
        }
    }, timeout);
}

AuthenticationContext.prototype._loadFrame = function (urlNavigate, frameName) {
    // This trick overcomes iframe navigation in IE
    // IE does not load the page consistently in iframe
    var self = this;
    self.info('LoadFrame: ' + frameName);
    var frameCheck = frameName;
    setTimeout(function () {
        var frameHandle = self._addAdalFrame(frameCheck);
        if (frameHandle.src === '' || frameHandle.src === 'about:blank') {
            frameHandle.src = urlNavigate;
            self._loadFrame(urlNavigate, frameCheck);
        }
    }, 500);
};

/**
 * Acquire token from cache if not expired and available. Acquires token from iframe if expired.
 * @param {string}   resource  ResourceUri identifying the target resource
 * @param {requestCallback} callback
 */
AuthenticationContext.prototype.acquireToken = function (resource, callback) {
    if (this._isEmpty(resource)) {
        this.warn('resource is required');
        callback('resource is required', null);
        return;
    }

    var token = this.getCachedToken(resource);
    if (token) {
        this.info('Token is already in cache for resource:' + resource);
        callback(null, token);
        return;
    }

    if (!this._user) {
        this.warn('User login is required');
        callback('User login is required', null);
        return;
    }

    // refresh attept with iframe
    //Already renewing for this resource, callback when we get the token.
    if (this._activeRenewals[resource]) {
        //Active renewals contains the state for each renewal.
        this.registerCallback(this._activeRenewals[resource], resource, callback);
    }
    else {
        this.event('adalAcquireToken', {resource: resource});
        if (resource === this.config.clientId) {
            // App uses idtoken to send to api endpoints
            // Default resource is tracked as clientid to store this token
            this.info('renewing idtoken');
            this._renewIdToken(callback);
        } else {
            this.info('renewing token ' + resource);
            this._renewToken(resource, callback);
        }
    }
};

/**
 * Redirect the Browser to Azure AD Authorization endpoint
 * @param {string}   urlNavigate The authorization request url
 */
AuthenticationContext.prototype.promptUser = function (urlNavigate) {
    if (urlNavigate) {
        this.info('Navigate to:' + urlNavigate);
        window.location.replace(urlNavigate);
    } else {
        this.error('Navigate url is empty');
    }
};

/**
 * Clear cache items.
 */
AuthenticationContext.prototype.clearCache = function () {
    this._saveItem(this.CONSTANTS.STORAGE.ACCESS_TOKEN_KEY, '');
    this._saveItem(this.CONSTANTS.STORAGE.EXPIRATION_KEY, 0);
    this._saveItem(this.CONSTANTS.STORAGE.SESSION_STATE, '');
    this._saveItem(this.CONSTANTS.STORAGE.STATE_LOGIN, '');
    this._renewStates = [];
    this._saveItem(this.CONSTANTS.STORAGE.START_PAGE, '');
    this._saveItem(this.CONSTANTS.STORAGE.START_PAGE_PARAMS, '');
    this._saveItem(this.CONSTANTS.STORAGE.USERNAME, '');
    this._saveItem(this.CONSTANTS.STORAGE.IDTOKEN, '');
    this._saveItem(this.CONSTANTS.STORAGE.ERROR, '');
    this._saveItem(this.CONSTANTS.STORAGE.ERROR_DESCRIPTION, '');
    var keys = this._getItem(this.CONSTANTS.STORAGE.TOKEN_KEYS);

    if (!this._isEmpty(keys)) {
        keys = keys.split(this.CONSTANTS.RESOURCE_DELIMETER);
        for (var i = 0; i < keys.length; i++) {
            this._saveItem(this.CONSTANTS.STORAGE.ACCESS_TOKEN_KEY + keys[i], '');
            this._saveItem(this.CONSTANTS.STORAGE.EXPIRATION_KEY + keys[i], 0);
        }
    }
    this._saveItem(this.CONSTANTS.STORAGE.TOKEN_KEYS, '');
};

/**
 * Clear cache items for a resource.
 */
AuthenticationContext.prototype.clearCacheForResource = function (resource) {
    this._saveItem(this.CONSTANTS.STORAGE.STATE_RENEW, '');
    this._saveItem(this.CONSTANTS.STORAGE.ERROR, '');
    this._saveItem(this.CONSTANTS.STORAGE.ERROR_DESCRIPTION, '');
    if (this._hasResource(resource)) {
        this._saveItem(this.CONSTANTS.STORAGE.ACCESS_TOKEN_KEY + resource, '');
        this._saveItem(this.CONSTANTS.STORAGE.EXPIRATION_KEY + resource, 0);
    }
};

/**
 * Logout user will redirect page to logout endpoint.
 * After logout, it will redirect to post_logout page if provided.
 */
AuthenticationContext.prototype.logOut = function () {
    this.clearCache();
    var tenant = 'common';
    var logout = '';
    this._user = null;
    if (this.config.tenant) {
        tenant = this.config.tenant;
    }

    if (this.config.instance) {
        this.instance = this.config.instance;
    }

    if (this.config.postLogoutRedirectUri) {
        logout = 'post_logout_redirect_uri=' + encodeURIComponent(this.config.postLogoutRedirectUri);
    }

    var urlNavigate = this.instance + tenant + '/oauth2/logout?' + logout;
    this.info('Logout navigate to: ' + urlNavigate);
    this.promptUser(urlNavigate);
};

AuthenticationContext.prototype._isEmpty = function (str) {
    return (typeof str === 'undefined' || !str || 0 === str.length);
};

/**
 * This callback is displayed as part of the Requester class.
 * @callback requestCallback
 * @param {string} error
 * @param {User} user
 */

/**
 * Gets a user profile
 * @param {requestCallback} cb - The callback that handles the response.
 */
AuthenticationContext.prototype.getUser = function (callback) {
    // IDToken is first call
    if (typeof callback !== 'function') {
        throw new Error('callback is not a function');
    }

    this.callback = callback;

    // user in memory
    if (this._user) {
        this.callback(null, this._user);
        return;
    }

    // frame is used to get idtoken
    var idtoken = this._getItem(this.CONSTANTS.STORAGE.IDTOKEN);
    if (!this._isEmpty(idtoken)) {
        this.info('User exists in cache: ');
        this._user = this._createUser(idtoken);
        this.callback(null, this._user);
    } else {
        this.warn('User information is not available');
        this.callback('User information is not available');
    }
};

AuthenticationContext.prototype._getDomainHint = function () {
    if (this._user && this._user.userName && this._user.userName.indexOf('@') > -1) {
        var parts = this._user.userName.split('@');
        // local part can include @ in quotes. Sending last part handles that.
        return parts[parts.length - 1];
    }

    return '';
};

AuthenticationContext.prototype._createUser = function (idToken) {
    var user = null;
    var parsedJson = this._extractIdToken(idToken);
    if (parsedJson && parsedJson.hasOwnProperty('aud')) {

        if (parsedJson.aud.toLowerCase() === this.config.clientId.toLowerCase()) {

            user = {
                userName: '',
                profile: parsedJson
            };

            if (parsedJson.hasOwnProperty('upn')) {
                user.userName = parsedJson.upn;
            } else if (parsedJson.hasOwnProperty('email')) {
                user.userName = parsedJson.email;
            }

            // set tenant once we have it
            if (parsedJson.hasOwnProperty('tid')) {
                this.config.tenant = parsedJson.tid;
            }
        } else {
            this.warn('IdToken has invalid aud field');
        }

    }

    return user;
};

AuthenticationContext.prototype._getHash = function (hash) {
    if (hash.indexOf('#/') > -1) {
        hash = hash.substring(hash.indexOf('#/') + 2);
    } else if (hash.indexOf('#') > -1) {
        hash = hash.substring(1);
    }

    return hash;
};

/**
 * Checks if hash contains access token or id token or error_description
 * @param {string} hash  -  Hash passed from redirect page
 * @returns {Boolean}
 */
AuthenticationContext.prototype.isCallback = function (hash) {
    hash = this._getHash(hash);
    var parameters = this._deserialize(hash);
    return (
        parameters.hasOwnProperty(this.CONSTANTS.ERROR_DESCRIPTION) ||
        parameters.hasOwnProperty(this.CONSTANTS.ACCESS_TOKEN) ||
        parameters.hasOwnProperty(this.CONSTANTS.ID_TOKEN)
    );
};

/**
 * Gets login error
 * @returns {string} error message related to login
 */
AuthenticationContext.prototype.getLoginError = function () {
    return this._getItem(this.CONSTANTS.STORAGE.LOGIN_ERROR);
};

/**
 * Gets requestInfo from given hash.
 * @returns {string} error message related to login
 */
AuthenticationContext.prototype.getRequestInfo = function (hash) {
    hash = this._getHash(hash);
    var parameters = this._deserialize(hash);
    var requestInfo = {
        valid: false,
        parameters: {},
        stateMatch: false,
        stateResponse: '',
        requestType: this.REQUEST_TYPE.UNKNOWN
    };
    if (parameters) {
        requestInfo.parameters = parameters;
        if (parameters.hasOwnProperty(this.CONSTANTS.ERROR_DESCRIPTION) ||
            parameters.hasOwnProperty(this.CONSTANTS.ACCESS_TOKEN) ||
            parameters.hasOwnProperty(this.CONSTANTS.ID_TOKEN)) {

            requestInfo.valid = true;

            // which call
            var stateResponse = '';
            if (parameters.hasOwnProperty('state')) {
                this.verbose('State: ' + parameters.state);
                stateResponse = parameters.state;
            } else {
                this.warn('No state returned');
                return requestInfo;
            }

            requestInfo.stateResponse = stateResponse;

            // async calls can fire iframe and login request at the same time if developer does not use the API as expected
            // incoming callback needs to be looked up to find the request type
            if (stateResponse === this._getItem(this.CONSTANTS.STORAGE.STATE_LOGIN)) {
                requestInfo.requestType = this.REQUEST_TYPE.LOGIN;
                requestInfo.stateMatch = true;
                return requestInfo;
            }

            // external api requests may have many renewtoken requests for different resource
            if (!requestInfo.stateMatch && window.parent && window.parent.AuthenticationContext()) {
                var statesInParentContext = window.parent.AuthenticationContext()._renewStates;
                for (var i = 0; i < statesInParentContext.length; i++) {
                    if (statesInParentContext[i] === requestInfo.stateResponse) {
                        requestInfo.requestType = this.REQUEST_TYPE.RENEW_TOKEN;
                        requestInfo.stateMatch = true;
                        break;
                    }
                }
            }
        }
    }

    return requestInfo;
};

AuthenticationContext.prototype._getResourceFromState = function (state) {
    if (state) {
        var splitIndex = state.indexOf('|');
        if (splitIndex > -1 && splitIndex + 1 < state.length) {
            return state.substring(splitIndex + 1);
        }
    }

    return '';
};

/**
 * Gets the cookie with the name provided
 */
AuthenticationContext.prototype._getCookie = function(name) {
    var value = "; " + document.cookie;
    var parts = value.split("; " + name + "=");
    if (parts.length == 2) return parts.pop().split(";").shift();
};

/**
 * Saves token from hash that is received from redirect.
 * @param {string} hash  -  Hash passed from redirect page
 * @returns {string} error message related to login
 */
AuthenticationContext.prototype.saveTokenFromHash = function (requestInfo) {
    var resource = this._getResourceFromState(requestInfo.stateResponse);
    this.event('adalIframeResponded', {resource: resource, arrAffinity: this._getCookie('ARRAffinity')});
    this.info('State status:' + requestInfo.stateMatch + '; Request type:' + requestInfo.requestType);

    this._saveItem(this.CONSTANTS.STORAGE.ERROR, '');
    this._saveItem(this.CONSTANTS.STORAGE.ERROR_DESCRIPTION, '');

    // Record error
    if (requestInfo.parameters.hasOwnProperty(this.CONSTANTS.ERROR_DESCRIPTION)) {
        this.info('Error :' + requestInfo.parameters.error + '; Error description:' + requestInfo.parameters[this.CONSTANTS.ERROR_DESCRIPTION]);
        this._saveItem(this.CONSTANTS.STORAGE.ERROR, requestInfo.parameters.error);
        this._saveItem(this.CONSTANTS.STORAGE.ERROR_DESCRIPTION, requestInfo.parameters[this.CONSTANTS.ERROR_DESCRIPTION]);

        if (requestInfo.requestType === this.REQUEST_TYPE.LOGIN) {
            this._loginInProgress = false;
            this._saveItem(this.CONSTANTS.STORAGE.LOGIN_ERROR, requestInfo.parameters.errorDescription);
        }
    } else {

        // It must verify the state from redirect
        if (requestInfo.stateMatch) {
            // record tokens to storage if exists
            this.info('State is right');
            if (requestInfo.parameters.hasOwnProperty(this.CONSTANTS.SESSION_STATE)) {
                this._saveItem(this.CONSTANTS.STORAGE.SESSION_STATE, requestInfo.parameters[this.CONSTANTS.SESSION_STATE]);
            }

            var keys;

            if (requestInfo.parameters.hasOwnProperty(this.CONSTANTS.ACCESS_TOKEN)) {
                this.info('Fragment has access token');
                if (!this._hasResource(resource)) {
                    keys = this._getItem(this.CONSTANTS.STORAGE.TOKEN_KEYS) || '';
                    this._saveItem(this.CONSTANTS.STORAGE.TOKEN_KEYS, keys + resource + this.CONSTANTS.RESOURCE_DELIMETER);
                }
                // save token with related resource
                this._saveItem(this.CONSTANTS.STORAGE.ACCESS_TOKEN_KEY + resource, requestInfo.parameters[this.CONSTANTS.ACCESS_TOKEN]);

                var accessTokenExpiration = this._expiresIn(requestInfo.parameters[this.CONSTANTS.EXPIRES_IN]);
                var accessTokenExpiresIn = (accessTokenExpiration - this._now());

                this._saveItem(this.CONSTANTS.STORAGE.EXPIRATION_KEY + resource, accessTokenExpiration);
                this.info('Access token successfully updated in local storage for resource:' + resource + ' expires in:' + accessTokenExpiresIn + ' seconds');
                this.event('adalAccessTokenUpdate', {resource: resource, expiresIn: accessTokenExpiresIn });
            }

            if (requestInfo.parameters.hasOwnProperty(this.CONSTANTS.ID_TOKEN)) {
                this.info('Fragment has id token');
                this._loginInProgress = false;
                this._user = this._createUser(requestInfo.parameters[this.CONSTANTS.ID_TOKEN]);
                if (this._user && this._user.profile) {
                    var storedNonce = this._getItem(this.CONSTANTS.STORAGE.NONCE_IDTOKEN);
                    if (this._user.profile.nonce !== storedNonce) {
                        var errorMessage = 'Nonce in profile is not the same as whats in storage. profile.nonce:' + this._user.profile.nonce + ', stored nonce:' + storedNonce;
                        this._user = null;
                        this._saveItem(this.CONSTANTS.STORAGE.LOGIN_ERROR, errorMessage);
                    } else {
                        this._saveItem(this.CONSTANTS.STORAGE.IDTOKEN, requestInfo.parameters[this.CONSTANTS.ID_TOKEN]);

                        // Save idtoken as access token for app itself
                        resource = this.config.loginResource ? this.config.loginResource : this.config.clientId;
                        if (!this._hasResource(resource)) {
                            keys = this._getItem(this.CONSTANTS.STORAGE.TOKEN_KEYS) || '';
                            this._saveItem(this.CONSTANTS.STORAGE.TOKEN_KEYS, keys + resource + this.CONSTANTS.RESOURCE_DELIMETER);
                        }
                        this._saveItem(this.CONSTANTS.STORAGE.ACCESS_TOKEN_KEY + resource, requestInfo.parameters[this.CONSTANTS.ID_TOKEN]);

                        var idTokenExpiration = this._user.profile.exp || 0;
                        var idTokenExpiresIn = (idTokenExpiration - this._now());

                        this._saveItem(this.CONSTANTS.STORAGE.EXPIRATION_KEY + resource, idTokenExpiration);
                        this.info('ID token successfully updated in local storage for resource:' + resource + ' expires in:' + idTokenExpiresIn + ' seconds');
                        this.event('adalIdTokenUpdate', {resource: resource, expiresIn: idTokenExpiresIn });
                    }
                }
            }
        } else {
            this._saveItem(this.CONSTANTS.STORAGE.ERROR, 'Invalid_state');
            this._saveItem(this.CONSTANTS.STORAGE.ERROR_DESCRIPTION, 'Invalid_state. state: ' + requestInfo.stateResponse);
        }
    }

    if (window.parent && window.parent.loadframeStatus && resource) {
        this.info('Removing iframe session tracking for resource:' + resource);
        this.event('adalIframeCleared', {resource: resource, reason: 'saved token from hash'});
        delete window.parent.loadframeStatus[resource];
    }
};

/**
 * Gets resource for given endpoint if mapping is provided with config.
 * @param {string} endpoint  -  API endoibt
 * @returns {string} resource for this API endpoint
 */
AuthenticationContext.prototype.getResourceForEndpoint = function (endpoint) {
    if (this.config && this.config.endpoints) {
        for (var configEndpoint in this.config.endpoints) {
            // configEndpoint is like /api/Todo requested endpoint can be /api/Todo/1
            if (endpoint.indexOf(configEndpoint) > -1) {
                return this.config.endpoints[configEndpoint];
            }
        }
    }

    // default resource will be clientid if nothing specified
    // App will use idtoken for calls to itself
    // check if it's staring from http or https, needs to match with app host
    if (endpoint.indexOf('http://') > -1 || endpoint.indexOf('https://') > -1) {
        if (this._getHostFromUri(endpoint) === this._getHostFromUri(this.config.redirectUri)) {
            return this.config.loginResource;
        }
    }
    // in angular level, the url for $http interceptor call could be relative url,
    // if it's relative call, we'll treat it as app backend call.
    else {
        return this.config.loginResource;
    }

    // if not the app's own backend or not a domain listed in the endpoints structure
    return null;
};

AuthenticationContext.prototype._getHostFromUri = function (uri) {
    // remove http:// or https:// from uri
    var extractedUri = String(uri).replace(/^(https?:)\/\//, '');

    extractedUri = extractedUri.split('/')[0];
    return extractedUri;
};

/*exported  oauth2Callback */
AuthenticationContext.prototype.handleWindowCallback = function () {
    // This is for regular javascript usage for redirect handling
    // need to make sure this is for callback
    var hash = window.location.hash;
    if (this.isCallback(hash)) {
        var requestInfo = this.getRequestInfo(hash);
        this.info('Returned from redirect url');
        this.saveTokenFromHash(requestInfo);
        var callback = null;
        if ((requestInfo.requestType === this.REQUEST_TYPE.RENEW_TOKEN && window.parent)) {
            // iframe call but same single page
            this.info('Window is in iframe');
            callback = window.parent.callBackMappedToRenewStates[requestInfo.stateResponse];
            this.verbose('iframe came back, deleting iframe session tracking for ' + requestInfo.stateResponse);
            window.src = '';
        } else if (window && window.oauth2Callback) {
            this.verbose('Window is redirecting');
            callback = this.callback;
        }

        window.location.hash = '';
        window.location = this._getItem(this.CONSTANTS.STORAGE.LOGIN_REQUEST);
        if (callback && requestInfo.requestType === this.REQUEST_TYPE.RENEW_TOKEN) {
            this.info('Executing window callback');
            callback(this._getItem(this.CONSTANTS.STORAGE.ERROR_DESCRIPTION), requestInfo.parameters[this.CONSTANTS.ACCESS_TOKEN] || requestInfo.parameters[this.CONSTANTS.ID_TOKEN]);
            return;
        }
    }
};

AuthenticationContext.prototype._getNavigateUrl = function (responseType, resource) {
    var tenant = 'common';
    if (this.config.tenant) {
        tenant = this.config.tenant;
    }

    if (this.config.instance) {
        this.instance = this.config.instance;
    }

    var urlNavigate = this.instance + tenant + '/oauth2/authorize' + this._serialize(responseType, this.config, resource) + this._addLibMetadata();
    this.info('Navigate url:' + urlNavigate);
    return urlNavigate;
};

AuthenticationContext.prototype._extractIdToken = function (encodedIdToken) {
    // id token will be decoded to get the username
    var decodedToken = this._decodeJwt(encodedIdToken);
    if (!decodedToken) {
        return null;
    }

    try {
        var base64IdToken = decodedToken.JWSPayload;
        var base64Decoded = this._base64DecodeStringUrlSafe(base64IdToken);
        if (!base64Decoded) {
            this.info('The returned id_token could not be base64 url safe decoded.');
            return null;
        }

        // ECMA script has JSON built-in support
        return JSON.parse(base64Decoded);
    } catch (err) {
        this.error('The returned id_token could not be decoded', err);
    }

    return null;
};

AuthenticationContext.prototype._extractUserName = function (encodedIdToken) {
    // id token will be decoded to get the username
    try {
        var parsed = this._extractIdToken(encodedIdToken);
        if (parsed) {
            if (parsed.hasOwnProperty('upn')) {
                return parsed.upn;
            } else if (parsed.hasOwnProperty('email')) {
                return parsed.email;
            }
        }
    } catch (err) {
        this.error('The returned id_token could not be decoded', err);
    }

    return null;
};

AuthenticationContext.prototype._base64DecodeStringUrlSafe = function (base64IdToken) {
    // html5 should support atob function for decoding
    base64IdToken = base64IdToken.replace(/-/g, '+').replace(/_/g, '/');
    if (window.atob) {
        return decodeURIComponent(escape(window.atob(base64IdToken))); // jshint ignore:line
    }
    else {
        return decodeURIComponent(escape(this._decode(base64IdToken)));
    }
};

//Take https://cdnjs.cloudflare.com/ajax/libs/Base64/0.3.0/base64.js and https://en.wikipedia.org/wiki/Base64 as reference.
AuthenticationContext.prototype._decode = function (base64IdToken) {
    var codes = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    base64IdToken = String(base64IdToken).replace(/=+$/, '');

    var length = base64IdToken.length;
    if (length % 4 === 1) {
        throw new Error('The token to be decoded is not correctly encoded.');
    }

    var h1, h2, h3, h4, bits, c1, c2, c3, decoded = '';
    for (var i = 0; i < length; i += 4) {
        //Every 4 base64 encoded character will be converted to 3 byte string, which is 24 bits
        // then 6 bits per base64 encoded character
        h1 = codes.indexOf(base64IdToken.charAt(i));
        h2 = codes.indexOf(base64IdToken.charAt(i + 1));
        h3 = codes.indexOf(base64IdToken.charAt(i + 2));
        h4 = codes.indexOf(base64IdToken.charAt(i + 3));

        // For padding, if last two are '='
        if (i + 2 === length - 1) {
            bits = h1 << 18 | h2 << 12 | h3 << 6;
            c1 = bits >> 16 & 255;
            c2 = bits >> 8 & 255;
            decoded += String.fromCharCode(c1, c2);
            break;
        }
        // if last one is '='
        else if (i + 1 === length - 1) {
            bits = h1 << 18 | h2 << 12
            c1 = bits >> 16 & 255;
            decoded += String.fromCharCode(c1);
            break;
        }

        bits = h1 << 18 | h2 << 12 | h3 << 6 | h4;

        // then convert to 3 byte chars
        c1 = bits >> 16 & 255;
        c2 = bits >> 8 & 255;
        c3 = bits & 255;

        decoded += String.fromCharCode(c1, c2, c3);
    }

    return decoded;
};

// Adal.node js crack function
AuthenticationContext.prototype._decodeJwt = function (jwtToken) {
    if (this._isEmpty(jwtToken)) {
        return null;
    };

    var idTokenPartsRegex = /^([^\.\s]*)\.([^\.\s]+)\.([^\.\s]*)$/;

    var matches = idTokenPartsRegex.exec(jwtToken);
    if (!matches || matches.length < 4) {
        this.warn('The returned id_token is not parseable.');
        return null;
    }

    var crackedToken = {
        header: matches[1],
        JWSPayload: matches[2],
        JWSSig: matches[3]
    };

    return crackedToken;
};

AuthenticationContext.prototype._convertUrlSafeToRegularBase64EncodedString = function (str) {
    return str.replace('-', '+').replace('_', '/');
};

AuthenticationContext.prototype._serialize = function (responseType, obj, resource) {
    var str = [];
    if (obj !== null) {
        str.push('?response_type=' + responseType);
        str.push('client_id=' + encodeURIComponent(obj.clientId));
        if (resource) {
            str.push('resource=' + encodeURIComponent(resource));
        }

        str.push('redirect_uri=' + encodeURIComponent(obj.redirectUri));
        str.push('state=' + encodeURIComponent(obj.state));

        if (obj.hasOwnProperty('slice')) {
            str.push('slice=' + encodeURIComponent(obj.slice));
        }

        if (obj.hasOwnProperty('extraQueryParameter')) {
            str.push(obj.extraQueryParameter);
        }

        if (obj.correlationId) {
            str.push('client-request-id=' + encodeURIComponent(obj.correlationId));
        }
    }

    return str.join('&');
};

AuthenticationContext.prototype._deserialize = function (query) {
    var match,
        pl = /\+/g,  // Regex for replacing addition symbol with a space
        search = /([^&=]+)=?([^&]*)/g,
        decode = function (s) {
            return decodeURIComponent(s.replace(pl, ' '));
        },
        obj = {};
    match = search.exec(query);
    while (match) {
        obj[decode(match[1])] = decode(match[2]);
        match = search.exec(query);
    }

    return obj;
};

/* jshint ignore:start */
AuthenticationContext.prototype._guid = function () {
    // RFC4122: The version 4 UUID is meant for generating UUIDs from truly-random or
    // pseudo-random numbers.
    // The algorithm is as follows:
    //     Set the two most significant bits (bits 6 and 7) of the
    //        clock_seq_hi_and_reserved to zero and one, respectively.
    //     Set the four most significant bits (bits 12 through 15) of the
    //        time_hi_and_version field to the 4-bit version number from
    //        Section 4.1.3. Version4
    //     Set all the other bits to randomly (or pseudo-randomly) chosen
    //     values.
    // UUID                   = time-low "-" time-mid "-"time-high-and-version "-"clock-seq-reserved and low(2hexOctet)"-" node
    // time-low               = 4hexOctet
    // time-mid               = 2hexOctet
    // time-high-and-version  = 2hexOctet
    // clock-seq-and-reserved = hexOctet:
    // clock-seq-low          = hexOctet
    // node                   = 6hexOctet
    // Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    // y could be 1000, 1001, 1010, 1011 since most significant two bits needs to be 10
    // y values are 8, 9, A, B
    var guidHolder = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    var hex = '0123456789abcdef';
    var r = 0;
    var guidResponse = "";
    for (var i = 0; i < 36; i++) {
        if (guidHolder[i] !== '-' && guidHolder[i] !== '4') {
            // each x and y needs to be random
            r = Math.random() * 16 | 0;
        }

        if (guidHolder[i] === 'x') {
            guidResponse += hex[r];
        } else if (guidHolder[i] === 'y') {
            // clock-seq-and-reserved first hex is filtered and remaining hex values are random
            r &= 0x3; // bit and with 0011 to set pos 2 to zero ?0??
            r |= 0x8; // set pos 3 to 1 as 1???
            guidResponse += hex[r];
        } else {
            guidResponse += guidHolder[i];
        }
    }

    return guidResponse;
};
/* jshint ignore:end */

AuthenticationContext.prototype._expiresIn = function (expires) {
    return this._now() + parseInt(expires, 10);
};

AuthenticationContext.prototype._now = function () {
    return Math.round(new Date().getTime() / 1000.0);
};

AuthenticationContext.prototype._addAdalFrame = function (iframeId) {
    if (typeof iframeId === 'undefined') {
        return;
    }

    var adalFrame = document.getElementById(iframeId);

    if (!adalFrame) {
        this.info('Attempting to add adal frame to document:' + iframeId);
        if (document.createElement && document.documentElement &&
            (window.opera || window.navigator.userAgent.indexOf('MSIE 5.0') === -1)) {
            var ifr = document.createElement('iframe');
            ifr.setAttribute('id', iframeId);
            ifr.style.visibility = 'hidden';
            ifr.style.position = 'absolute';
            ifr.style.width = ifr.style.height = ifr.borderWidth = '0px';

            adalFrame = document.getElementsByTagName('body')[0].appendChild(ifr);
        }
        else if (document.body && document.body.insertAdjacentHTML) {
            document.body.insertAdjacentHTML('beforeEnd', '<iframe name="' + iframeId + '" id="' + iframeId + '" style="display:none"></iframe>');
        }
        if (window.frames && window.frames[iframeId]) {
            adalFrame = window.frames[iframeId];
        }

        if(adalFrame) {
            this.info('Added adal frame to document:' + iframeId);
            this.event('adalAddIframe', {resource: iframeId});
        }
    }

    return adalFrame;
};

AuthenticationContext.prototype._saveItem = function (key, obj) {

    if (this.config && this.config.cacheLocation && this.config.cacheLocation === 'localStorage') {

        if (!this._supportsLocalStorage()) {
            this.info('Local storage is not supported');
            return false;
        }

        localStorage.setItem(key, obj);

        return true;
    }

    // Default as session storage
    if (!this._supportsSessionStorage()) {
        this.info('Session storage is not supported');
        return false;
    }

    sessionStorage.setItem(key, obj);
    return true;
};

AuthenticationContext.prototype._getItem = function (key) {

    if (this.config && this.config.cacheLocation && this.config.cacheLocation === 'localStorage') {

        if (!this._supportsLocalStorage()) {
            this.info('Local storage is not supported');
            return null;
        }

        return localStorage.getItem(key);
    }

    // Default as session storage
    if (!this._supportsSessionStorage()) {
        this.info('Session storage is not supported');
        return null;
    }

    return sessionStorage.getItem(key);
};

AuthenticationContext.prototype._supportsLocalStorage = function () {
    try {
        return 'localStorage' in window && window['localStorage'];
    } catch (e) {
        return false;
    }
};

AuthenticationContext.prototype._supportsSessionStorage = function () {
    try {
        return 'sessionStorage' in window && window['sessionStorage'];
    } catch (e) {
        return false;
    }
};

AuthenticationContext.prototype._cloneConfig = function (obj) {
    if (null === obj || 'object' !== typeof obj) {
        return obj;
    }

    var copy = {};
    for (var attr in obj) {
        if (obj.hasOwnProperty(attr)) {
            copy[attr] = obj[attr];
        }
    }
    return copy;
};

AuthenticationContext.prototype._addLibMetadata = function () {
    // x-client-SKU
    // x-client-Ver
    return '&x-client-SKU=Js&x-client-Ver=' + this._libVersion();
};

AuthenticationContext.prototype.log = function (level, message, error) {
    if (level <= Logging.level) {
        var correlationId = this.config.correlationId;
        var timestamp = new Date().toUTCString();

        var formattedMessage = timestamp + ':' + correlationId + '-' + this._libVersion() + '-' + this.CONSTANTS.LEVEL_STRING_MAP[level] + ' ' + message;

        if (error) {
            formattedMessage += '\nstack:\n' + error.stack;
        }

        Logging.log(formattedMessage);
    }
};


/**
 * Logs to parent window logger if exists.
 */
AuthenticationContext.prototype.tryLogtoTopFrame = function (logFunction, message, error) {
    if(window.self !== window.top) {
        var logger = window.top ? window.top['AuthenticationLogger'] : undefined;
        var format = 'Iframe - AuthenticationContext: {0}, {1}';

        if (error) {
            format += ', {2}';
        }

        logger &&
        logger[logFunction] &&
        logger[logFunction].call(logger, format, this.config.correlationId, message, error);
    }
};

/**
 * Sends events to parent window callback if exists.
 */
AuthenticationContext.prototype.trySendEventToTopFrame = function (eventName, eventData) {
    if(window.self !== window.top) {
        var callback = window.top ? window.top['AuthenticationLogEventCallback'] : undefined;
        callback &&
        callback(eventName, eventData);
    }
};

AuthenticationContext.prototype.error = function (message, error) {
    this.log(this.CONSTANTS.LOGGING_LEVEL.ERROR, message, error);
    this.tryLogtoTopFrame('error', message, error);
};

AuthenticationContext.prototype.warn = function (message) {
    this.log(this.CONSTANTS.LOGGING_LEVEL.WARN, message, null);
    this.tryLogtoTopFrame('warn', message);
};

AuthenticationContext.prototype.info = function (message) {
    this.log(this.CONSTANTS.LOGGING_LEVEL.INFO, message, null);
    this.tryLogtoTopFrame('info', message);
};

AuthenticationContext.prototype.verbose = function (message) {
    this.log(this.CONSTANTS.LOGGING_LEVEL.VERBOSE, message, null);
    this.tryLogtoTopFrame('verbose', message);
};

AuthenticationContext.prototype.event = function (eventName, eventData) {
    this.trySendEventToTopFrame(eventName, eventData);
};


AuthenticationContext.prototype._libVersion = function () {
    return '1.0.9';
};
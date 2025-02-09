/**
 * @fileoverview App Auth Box API Session.
 */

// ------------------------------------------------------------------------------
// Requirements
// ------------------------------------------------------------------------------

import assert from 'assert';
import { Promise } from 'bluebird';
import errors from '../util/errors';

// ------------------------------------------------------------------------------
// Typedefs
// ------------------------------------------------------------------------------

type Config = any /* FIXME */;
type TokenManager = any /* FIXME */;
type TokenStore = any /* FIXME */;
type TokenInfo = any /* FIXME */;
type TokenRequestOptions = any /* FIXME */;

// ------------------------------------------------------------------------------
// Private
// ------------------------------------------------------------------------------

/**
 * Validate that an object is a valid TokenStore object
 *
 * @param {Object} obj the object to validate
 * @returns {boolean} returns true if the passed in object is a valid TokenStore object that
 * has all the expected properties. false otherwise.
 * @private
 */
function isObjectValidTokenStore(obj: Record<string, any>) {
	return Boolean(obj && obj.read && obj.write && obj.clear);
}

// ------------------------------------------------------------------------------
// Public
// ------------------------------------------------------------------------------

/**
 * App Auth Box API Session.
 *
 * The App Auth API Session holds an accessToken for an app user or enterprise,
 * which it returns to the client so that it may make calls on behalf of
 * these entities.
 *
 * These access tokens will be refreshed in the background if a request is made within the
 * "stale buffer" (defaults to 10 minutes before the token is set to expire).
 * If the token is also expired, all incoming requests will be held until a fresh token
 * is retrieved.
 *
 * @param {string} type The type of the entity to authenticate the app auth session as, "user" or "enterprise"
 * @param {string} id The Box ID of the entity to authenticate as
 * @param {Config} config The SDK configuration options
 * @param {TokenManager} tokenManager The TokenManager
 * @param {TokenStore} [tokenStore] The token store instance to use for caching token info
 * @constructor
 */
class AppAuthSession {
	_type: string;
	_id: string;
	_config: Config;
	_tokenManager: TokenManager;
	_tokenStore: TokenStore | null;
	_tokenInfo: TokenInfo;
	_refreshPromise: Promise<any> | null;

	constructor(
		type: string,
		id: string,
		config: Config,
		tokenManager: TokenManager,
		tokenStore?: TokenStore
	) {
		this._type = type;
		this._id = id;
		this._config = config;
		this._tokenManager = tokenManager;

		// If tokenStore was provided, set the persistent data & current store operations
		if (tokenStore) {
			assert(
				isObjectValidTokenStore(tokenStore),
				'Token store provided is improperly formatted. Methods required: read(), write(), clear().'
			);
			this._tokenStore = Promise.promisifyAll(tokenStore);
		}

		// The TokenInfo object for this app auth session
		this._tokenInfo = null;

		// Indicates if tokens are currently being refreshed
		this._refreshPromise = null;
	}

	/**
	 * Initiate a refresh of the app auth access tokens. New tokens should be passed
	 * to the caller, and then cached for later use.
	 *
	 * @param {TokenRequestOptions} [options] - Sets optional behavior for the token grant
	 * @returns {Promise<string>} Promise resolving to the access token
	 * @private
	 */
	_refreshAppAuthAccessToken(options?: TokenRequestOptions) {
		// If tokens aren't already being refreshed, start the refresh
		if (!this._refreshPromise) {
			this._refreshPromise = this._tokenManager
				.getTokensJWTGrant(this._type, this._id, options)
				.then((tokenInfo: TokenInfo) => {
					// Set new token info and propagate the new access token
					this._tokenInfo = tokenInfo;

					if (this._tokenStore) {
						return this._tokenStore
							.writeAsync(tokenInfo)
							.then(() => tokenInfo.accessToken);
					}

					return tokenInfo.accessToken;
				})
				.finally(() => {
					// Refresh complete, clear promise
					this._refreshPromise = null;
				});
		}

		return this._refreshPromise;
	}

	/**
	 * Produces a valid, app auth access token.
	 * Performs a refresh before returning if the current token is expired. If the current
	 * token is considered stale but still valid, return the current token but initiate a
	 * new refresh in the background.
	 *
	 * @param {TokenRequestOptions} [options] - Sets optional behavior for the token grant
	 * @returns {Promise<string>} Promise resolving to the access token
	 */
	getAccessToken(options?: TokenRequestOptions) {
		var expirationBuffer = Math.max(
			this._config.expiredBufferMS,
			this._config.staleBufferMS
		);

		// If we're initializing the client and have a token store, try reading from it
		if (!this._tokenInfo && this._tokenStore) {
			return this._tokenStore.readAsync().then((tokenInfo: TokenInfo) => {
				if (
					!this._tokenManager.isAccessTokenValid(tokenInfo, expirationBuffer)
				) {
					// Token store contains expired tokens, refresh
					return this._refreshAppAuthAccessToken(options);
				}

				this._tokenInfo = tokenInfo;
				return tokenInfo.accessToken;
			});
		}

		// If the current token is not fresh, get a new token. All incoming
		// requests will be held until a fresh token is retrieved.
		if (
			!this._tokenInfo ||
			!this._tokenManager.isAccessTokenValid(this._tokenInfo, expirationBuffer)
		) {
			return this._refreshAppAuthAccessToken(options);
		}

		// Your token is not currently stale! Return the current access token.
		return Promise.resolve(this._tokenInfo.accessToken);
	}

	/**
	 * Revokes the app auth token used by this session, and clears the saved tokenInfo.
	 *
	 * @param {TokenRequestOptions} [options]- Sets optional behavior for the token grant
	 * @returns {Promise} Promise resolving if the revoke succeeds
	 */
	revokeTokens(options: TokenRequestOptions) {
		// The current app auth token is revoked (but a new one will be created automatically as needed).
		var tokenInfo = this._tokenInfo || {},
			accessToken = tokenInfo.accessToken;
		this._tokenInfo = null;
		return this._tokenManager.revokeTokens(accessToken, options);
	}

	/**
	 * Exchange the client access token for one with lower scope
	 * @param {string|string[]} scopes The scope(s) requested for the new token
	 * @param {string} [resource] The absolute URL of an API resource to scope the new token to
	 * @param {Object} [options] - Optional parameters
	 * @param {TokenRequestOptions} [options.tokenRequestOptions] - Sets optional behavior for the token grant
	 * @param {ActorParams} [options.actor] - Optional actor parameters for creating annotator tokens
	 * @returns {Promise<TokenInfo>} Promise resolving to the new token info
	 */
	exchangeToken(
		scopes: string | string[],
		resource?: string,
		options?: {
			tokenRequestOptions?: TokenRequestOptions;
			actor?: any /* FIXME */;
		}
	) {
		return this.getAccessToken(options).then((accessToken: string) =>
			this._tokenManager.exchangeToken(accessToken, scopes, resource, options)
		);
	}

	/**
	 * Handle an an "Expired Tokens" Error. If our tokens are expired, we need to clear the token
	 * store (if present) before continuing.
	 *
	 * @param {Errors~ExpiredTokensError} err An "expired tokens" error including information
	 *  about the request/response.
	 * @returns {Promise<Error>} Promise resolving to an error.  This will
	 *  usually be the original response error, but could an error from trying to access the
	 *  token store as well.
	 */
	handleExpiredTokensError(err: any /* FIXME */) {
		if (!this._tokenStore) {
			return Promise.resolve(err);
		}

		// If a token store is available, clear the store and throw either error
		// eslint-disable-next-line promise/no-promise-in-callback
		return this._tokenStore
			.clearAsync()
			.catch((e: any) => errors.unwrapAndThrow(e))
			.then(() => {
				throw err;
			});
	}
}

/**
 * @module box-node-sdk/lib/sessions/app-auth-session
 * @see {@Link AppAuthSession}
 */
export = AppAuthSession;

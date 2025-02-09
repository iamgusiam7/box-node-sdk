/**
 * @fileoverview Event stream backed by the events API
 */

// ------------------------------------------------------------------------------
// Requirements
// ------------------------------------------------------------------------------

import { Promise } from 'bluebird';
import qs from 'querystring';
import { Readable } from 'stream';
import util from 'util';
import BoxClient from './box-client';

// ------------------------------------------------------------------------------
// Typedefs
// ------------------------------------------------------------------------------

type Options = {
	retryDelay: number;
	deduplicationFilterSize: number;
	fetchInterval: number;
};

type LongPollInfo = {
	max_retries: number;
	retry_timeout: number;
	url: string;
};

// ------------------------------------------------------------------------------
// Private
// ------------------------------------------------------------------------------

const DEFAULT_OPTIONS: Options = Object.freeze({
	deduplicationFilterSize: 5000,
	retryDelay: 1000,
	fetchInterval: 1000,
});

// ------------------------------------------------------------------------------
// Public
// ------------------------------------------------------------------------------

/**
 * Stream of Box events from a given client and point in time.
 * @param {BoxClient} client The client to use to get events
 * @param {string} streamPosition The point in time to start at
 * @param {Object} [options] Optional parameters
 * @param {int} [options.retryDelay=1000] Number of ms to wait before retrying after an error
 * @param {int} [options.deduplicationFilterSize=5000] Number of IDs to track for deduplication
 * @param {int} [options.fetchInterval=1000] Minimunm number of ms between calls for more events
 * @constructor
 * @extends Readable
 */
class EventStream extends Readable {
	_client: BoxClient;
	_streamPosition: string;
	_longPollInfo?: LongPollInfo;
	_longPollRetries: number;
	_dedupHash: Record<string, boolean>;
	_rateLimiter: Promise<any>;
	_options: Options;
	_retryTimer?: NodeJS.Timeout | number;

	constructor(
		client: BoxClient,
		streamPosition: string,
		options?: Partial<Options>
	) {
		super({
			objectMode: true,
		});

		/**
		 * @var {BoxClient} The client for making API calls
		 * @private
		 */
		this._client = client;

		/**
		 * @var {string} The latest stream position
		 * @private
		 */
		this._streamPosition = streamPosition;

		/**
		 * @var {?Object} The information for how to long poll
		 * @private
		 */
		this._longPollInfo = undefined;

		/**
		 * @var {int} The number of long poll requests we've made against one URL so far
		 * @private
		 */
		this._longPollRetries = 0;

		/**
		 * @var {Object.<string, boolean>} Hash of event IDs we've already pushed
		 * @private
		 */
		this._dedupHash = {};

		/**
		 * Rate limiting promise to ensure that events are not fetched too often,
		 * initially resolved to allow an immediate API call.
		 * @var {Promise}
		 * @private
		 */
		this._rateLimiter = Promise.resolve();

		this._options = Object.assign({}, DEFAULT_OPTIONS, options);
	}

	/**
	 * Retrieve the url and params for long polling for new updates
	 * @returns {Promise} Promise for testing purposes
	 * @private
	 */
	getLongPollInfo() {
		if (this.destroyed) {
			return Promise.resolve(false);
		}

		return this._client.events
			.getLongPollInfo()
			.then((longPollInfo: LongPollInfo) => {
				// On getting new long poll info, reset everything
				this._longPollInfo = longPollInfo;
				this._longPollRetries = 0;

				return this.doLongPoll();
			})
			.catch((err: any /* FIXME */) => {
				this.emit('error', err);

				// Only retry on resolvable errors
				if (!err.authExpired) {
					this.retryPollInfo();
				}
			});
	}

	/**
	 * Long poll for notification of new events.	We do this rather than
	 * polling for the events directly in order to minimize the number of API
	 * calls necessary.
	 * @returns {Promise} Promise for testing pruposes
	 * @private
	 */
	doLongPoll() {
		if (this.destroyed) {
			return Promise.resolve(false);
		}

		// If we're over the max number of retries, reset
		if (this._longPollRetries > this._longPollInfo!.max_retries) {
			return this.getLongPollInfo();
		}

		var url = this._longPollInfo!.url,
			qsDelim = url.indexOf('?'),
			query = {};

		// Break out the query params, otherwise the request URL gets messed up
		if (qsDelim > 0) {
			query = qs.parse(url.substr(qsDelim + 1));
			url = url.substr(0, qsDelim);
		}

		(query as Record<string, any>).stream_position = this._streamPosition;

		var options = {
			qs: query,
			timeout: this._longPollInfo!.retry_timeout * 1000,
		};

		this._longPollRetries += 1;
		return this._client
			.wrapWithDefaultHandler(this._client.get)(url, options)
			.then((data: any /* FIXME */) => {
				if (this.destroyed) {
					return false;
				}

				if (data.message === 'reconnect') {
					return this.getLongPollInfo();
				}

				// We don't expect any messages other than reconnect and new_change, so if
				// we get one just retry the long poll
				if (data.message !== 'new_change') {
					return this.doLongPoll();
				}

				return this.fetchEvents();
			})
			.catch(() => {
				this.retryPollInfo();
			});
	}

	/**
	 * Retries long-polling after a delay.
	 * Does not attempt if stream is already destroyed.
	 * @returns {void}
	 * @private
	 */
	retryPollInfo() {
		if (!this.destroyed) {
			this._retryTimer = setTimeout(
				() => this.getLongPollInfo(),
				this._options.retryDelay
			);
		}
	}

	/**
	 * Fetch the latest group of events and push them into the stream
	 * @returns {Promise} Promise for testing purposes
	 * @private
	 */
	fetchEvents() {
		if (this.destroyed) {
			return Promise.resolve(false);
		}

		var eventParams = {
			stream_position: this._streamPosition,
			limit: 500,
		};

		// Get new events after the rate limiter expires
		return this._rateLimiter.then(() =>
			this._client.events
				.get(eventParams)
				.then((events: any /* FIXME */) => {
					// Reset the rate limiter
					this._rateLimiter = Promise.delay(this._options.fetchInterval);

					// If the response wasn't what we expected, re-poll
					if (!events.entries || !events.next_stream_position) {
						return this.doLongPoll();
					}

					this._streamPosition = events.next_stream_position;

					// De-duplicate the fetched events, since the API often returns
					// the same events at multiple subsequent stream positions
					var newEvents = events.entries.filter(
						(event: any /* FIXME */) => !this._dedupHash[event.event_id]
					);

					// If there aren't any non-duplicate events, go back to polling
					if (newEvents.length === 0) {
						return this.doLongPoll();
					}

					// Pause the stream to avoid race conditions while pushing in the new events.
					// Without this, _read() would be called again from inside each push(),
					// resulting in multiple parallel calls to fetchEvents().
					// See https://github.com/nodejs/node/issues/3203
					var wasPaused = this.isPaused();
					this.pause();

					// Push new events into the stream
					newEvents.forEach((event: any /* FIXME */) => {
						this._dedupHash[event.event_id] = true;
						this.push(event);
					});

					if (!wasPaused) {
						// This will deliver the events and trigger the next call to _read() once they have been consumed.
						this.resume();
					}

					// Once the deduplication filter gets too big, clean it up
					if (
						Object.keys(this._dedupHash).length >=
						this._options.deduplicationFilterSize
					) {
						this.cleanupDedupFilter(events.entries);
					}

					return true;
				})
				.catch((err: any /* FIXME */) => {
					this.emit('error', err);

					this.retryPollInfo();
				})
		);
	}

	/**
	 * Clean up the deduplication filter, to prevent it from growing
	 * too big and eating up memory.	We look at the latest set of events
	 * returned and assume that any IDs not in that set don't need to be
	 * tracked for deduplication any more.
	 * @param {Object[]} latestEvents The latest events from the API
	 * @returns {void}
	 * @private
	 */
	cleanupDedupFilter(latestEvents: any /* FIXME */) {
		var dedupIDs = Object.keys(this._dedupHash);

		dedupIDs.forEach((eventID) => {
			var isEventCleared = !latestEvents.find(
				(e: any /* FIXME */) => e.event_id === eventID
			);
			if (isEventCleared) {
				delete this._dedupHash[eventID];
			}
		});
	}

	/**
	 * Implementation of the stream-internal read function.	This is called
	 * by the stream whenever it needs more data, and will not be called again
	 * until data is pushed into the stream.
	 * @returns {void}
	 * @private
	 */
	_read() {
		// Start the process of getting new events
		this.getLongPollInfo();
	}

	/**
	 * Implementation of stream-internal `_destroy` function (v8.0.0 and later).
	 * Called by stream consumers to effectively stop polling via the public
	 * `destroy()`.
	 * @returns {void}
	 * @private
	 */
	_destroy() {
		clearTimeout(this._retryTimer as number);
		delete this._retryTimer;
	}
}

// backwards-compat for Node.js pre-v8.0.0
/* istanbul ignore if */
if (typeof Readable.prototype.destroy !== 'function') {
	/**
	 * Destroys the stream.  Rough polyfill for `Readable#destroy`.
	 * @returns {void}
	 * @public
	 */
	EventStream.prototype.destroy = function () {
		if (!this.destroyed) {
			process.nextTick(() => {
				this.emit('close');
			});
			this.destroyed = true;
			this._destroy();
		}
	};
}

export = EventStream;

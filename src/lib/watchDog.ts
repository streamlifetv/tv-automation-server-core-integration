import { EventEmitter } from 'events'
import _ = require('underscore')

/**
 * Watchdog is used to make sure there is a working connection with Core.
 * Usage: in the function provided to addCheck, we should send a message to core
 * and resolve the returned promise when we've got a good reply.
 * If the Watchdog doesn't get it's checkFunctions resolved withing a certain time
 * it will forcefully quit the Node process (or emit the 'exit' event.
 */
export class WatchDog extends EventEmitter {
	public timeout: number
	private _checkTimeout: NodeJS.Timer | null = null
	private _dieTimeout: NodeJS.Timer | null = null
	private _watching: boolean = false
	private _checkFunctions: Array<() => Promise<any>> = []

	constructor (_timeout?: number) {
		super()
		this.timeout = _timeout || 60 * 1000
	}
	public startWatching () {
		if (!this._watching) {
			this._watch()
		}
		this._watching = true
	}
	public addCheck (fcn: () => Promise<any>) {
		this._checkFunctions.push(fcn)
	}
	public removeCheck (fcn: () => Promise<any>) {
		let i = this._checkFunctions.indexOf(fcn)
		if (i !== -1) this._checkFunctions.splice(i, 1)
	}
	private _everythingIsOk () {
		this._watch()
	}
	private _watch () {
		if (this._dieTimeout) clearTimeout(this._dieTimeout)
		if (this._checkTimeout) clearTimeout(this._checkTimeout)

		this._checkTimeout = setTimeout(() => {
			Promise.all(
				_.map(this._checkFunctions, (fcn: () => Promise<any>) => {
					return fcn()
				})
			)
			.then(() => {
				// console.log('all promises have resolved')
				// all promises have resolved
				this._everythingIsOk()
			})
			.catch(() => {
				// do nothing, the die-timeout will trigger soon
			})
			this._dieTimeout = setTimeout(() => {
				// This timeout SHOULD have been aborted by .everythingIsOk
				// but since it's not, it is our job to quit gracefully, triggering a reset
				if (this.listenerCount('message') > 0) {
					this.emit('message', 'Watchdog: Quitting process!')
				} else {
					console.log('Watchdog: Quitting!')
				}
				if (this.listenerCount('exit') > 0) {
					this.emit('exit')
				} else {
					process.exit(42)
				}
			}, 5000)
		}, this.timeout)
	}
}

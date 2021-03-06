import { EventEmitter } from 'events'
import * as _ from 'underscore'

import { DDPConnector, DDPConnectorOptions, Observer } from './ddpConnector'
import { PeripheralDeviceAPI as P, PeripheralDeviceAPI } from './corePeripherals'
import { TimeSync } from './timeSync'
import { WatchDog } from './watchDog'

const DataStore = require('data-store')
const Random = require('ddp-random')

export interface InitOptions {
	type: P.DeviceType,
	name: string,
	connectionId: string,
	parentDeviceId?: string,
	versions?: {
		[libraryName: string]: string
	}
}

export interface CoreCredentials {
	deviceId: string,
	deviceToken: string
}

export interface CoreOptions extends CoreCredentials {
	deviceType: P.DeviceType
	deviceName: string,
	versions?: {
		[libraryName: string]: string
	},
	watchDog?: boolean

}
export interface CollectionObj {
	_id: string
	[key: string]: any
}
export interface Collection {
	find: (selector: any) => Array<CollectionObj>
	findOne: (selector: any) => CollectionObj
}

export class CoreConnection extends EventEmitter {

	private _ddp: DDPConnector
	private _parent: CoreConnection | null = null
	private _children: Array<CoreConnection> = []
	private _coreOptions: CoreOptions
	private _timeSync: TimeSync
	private _watchDog?: WatchDog
	private _watchDogPingResponse: string = ''
	private _connected: boolean = false
	private _autoSubscriptions: { [subscriptionId: string]: {
		publicationName: string,
		params: Array<any>
	}} = {}
	private _sentConnectionId: string = ''
	private _pingTimeout: NodeJS.Timer | null = null

	constructor (coreOptions: CoreOptions) {
		super()

		this._coreOptions = coreOptions

		if (this._coreOptions.watchDog) {
			this._watchDog = new WatchDog()
			this._watchDog.on('message', msg => this.emit('error', msg))
			this._watchDog.startWatching()
		}
	}
	static getStore (name: string) {
		return new DataStore(name)
	}
	static getCredentials (name: string): CoreCredentials {
		let store = CoreConnection.getStore(name)

		let credentials: CoreCredentials = store.get('CoreCredentials')
		if (!credentials) {
			credentials = CoreConnection.generateCredentials()
			store.set('CoreCredentials', credentials)
		}

		return credentials
	}
	static deleteCredentials (name: string) {
		let store = CoreConnection.getStore(name)

		store.set('CoreCredentials', null)
	}
	static generateCredentials (): CoreCredentials {
		return {
			deviceId: Random.id(),
			deviceToken: Random.id()
		}
	}
	init (ddpOptionsORParent?: DDPConnectorOptions | CoreConnection): Promise<string> {
		this.on('connected', () => this._renewAutoSubscriptions())

		if (ddpOptionsORParent instanceof CoreConnection) {
			this._setParent(ddpOptionsORParent)

			return Promise.resolve()
				.then(() => {
					return this._sendInit()
				})
		} else {
			let ddpOptions = ddpOptionsORParent || {
				host: '127.0.0.1',
				port: 3000
			}
			if (!_.has(ddpOptions, 'autoReconnect')) 		ddpOptions.autoReconnect = true
			if (!_.has(ddpOptions, 'autoReconnectTimer')) 	ddpOptions.autoReconnectTimer = 1000
			return new Promise((resolve) => {
				this._ddp = new DDPConnector(ddpOptions)

				this._ddp.on('error', (err) => {
					this.emit('error', err)
				})
				this._ddp.on('failed', (err) => {
					this.emit('failed', err)
				})
				this._ddp.on('connectionChanged', (connected: boolean) => {
					this._setConnected(connected)

					this._maybeSendInit()
					.catch((err) => {
						this.emit('error', err)
					})
				})
				this._ddp.on('connected', () => {
					// this.emit('connected')
					if (this._watchDog) this._watchDog.addCheck(() => this._watchDogCheck())
				})
				this._ddp.on('disconnected', () => {
					// this.emit('disconnected')
					if (this._watchDog) this._watchDog.removeCheck(() => this._watchDogCheck())
				})
				resolve()
			}).then(() => {
				return this._ddp.createClient()
			}).then(() => {
				return this._ddp.connect()
			}).then(() => {
				return this._sendInit()
			}).then((deviceId) => {
				// console.log('syncing systemTime...')
				this._timeSync = new TimeSync({
					serverDelayTime: 0
				}, () => {
					return this.callMethod(PeripheralDeviceAPI.methods.getTimeDiff)
					.then((stat) => {
						return stat.currentTime
					})
				})

				return this._timeSync.init()
				.then(() => {
					this._triggerPing()
				})
				.then(() => {
					// console.log('Time synced! (diff: ' + this._timeSync.diff + ', quality: ' + this._timeSync.quality + ')')
					return deviceId
				})
			})
		}
	}
	destroy (): Promise<void> {
		if (this._parent) {
			this._removeParent()
		} else {
			this._removeParent()
			if (this._ddp) {
				this._ddp.close()
			}
		}
		this.removeAllListeners('error')
		this.removeAllListeners('connectionChanged')
		this.removeAllListeners('connected')
		this.removeAllListeners('disconnected')
		this.removeAllListeners('failed')

		if (this._pingTimeout) {
			clearTimeout(this._pingTimeout)
			this._pingTimeout = null
		}

		return Promise.all(
			_.map(this._children, (child: CoreConnection) => {
				return child.destroy()
			})
		).then(() => {
			this._children = []
			return Promise.resolve()
		})
	}
	addChild (child: CoreConnection) {
		this._children.push(child)
	}
	removeChild (childToRemove: CoreConnection) {
		let removeIndex = -1
		this._children.forEach((c, i) => {
			if (c === childToRemove) removeIndex = i
		})
		if (removeIndex !== -1) {
			this._children.splice(removeIndex, 1)
		}
	}
	onConnectionChanged (cb: (connected: boolean) => void) {
		this.on('connectionChanged', cb)
	}
	onConnected (cb: () => void) {
		this.on('connected', cb)
	}
	onDisconnected (cb: () => void) {
		this.on('disconnected', cb)
	}
	onError (cb: (err: Error) => void) {
		this.on('error', cb)
	}
	onFailed (cb: (err: Error) => void) {
		this.on('failed', cb)
	}
	get ddp (): DDPConnector {
		if (this._parent) return this._parent.ddp
		else return this._ddp
	}
	get connected () {
		return this._connected
		// return (this.ddp ? this.ddp.connected : false)
	}
	get deviceId () {
		return this._coreOptions.deviceId
	}
	setStatus (status: P.StatusObject): Promise<P.StatusObject> {

		return new Promise((resolve, reject) => {

			this.ddp.ddpClient.call(P.methods.setStatus, [
				this._coreOptions.deviceId,
				this._coreOptions.deviceToken,
				status
			], (err: Error, returnedStatus: P.StatusObject) => {
				if (err) {
					reject(err)
				} else {
					resolve(returnedStatus)
				}
			})
		})
	}
	callMethod (methodName: PeripheralDeviceAPI.methods | string, attrs?: Array<any>): Promise<any> {
		return new Promise((resolve, reject) => {

			let fullAttrs = [
				this._coreOptions.deviceId,
				this._coreOptions.deviceToken
			].concat(attrs || [])

			this.ddp.ddpClient.call(methodName, fullAttrs, (err: Error, id: string) => {
				if (err) {
					reject(err)
				} else {
					resolve(id)
				}
			})
		})
	}
	unInitialize (): Promise<string> {
		return this.callMethod(P.methods.unInitialize)
	}
	mosManipulate (method: string, ...attrs: Array<any>) {
		return this.callMethod(method, attrs)
	}
	getPeripheralDevice (): Promise<any> {
		return this.callMethod(P.methods.getPeripheralDevice)
	}
	getCollection (collectionName: string): Collection {
		let collection = this.ddp.ddpClient.collections[collectionName] || {}

		let c: Collection = {
			find (selector?: any): Array<CollectionObj> {
				if (_.isUndefined(selector)) {
					return _.values(collection)
				} else if (_.isFunction(selector)) {
					return _.filter(_.values(collection), selector)
				} else if (_.isObject(selector)) {
					return _.where(_.values(collection), selector)
				} else {
					return [collection[selector]]
				}
			},
			findOne (selector: any): CollectionObj {
				return c.find(selector)[0]
			}
		}
		return c
	}
	subscribe (publicationName: string, ...params: Array<any>): Promise<string> {
		return new Promise((resolve, reject) => {
			try {
				let subscriptionId = this.ddp.ddpClient.subscribe(
					publicationName,	// name of Meteor Publish function to subscribe to
					params.concat([this._coreOptions.deviceToken]), // parameters used by the Publish function
					() => { 		// callback when the subscription is complete
						resolve(subscriptionId)
					}
				)
			} catch (e) {
				// console.log(this.ddp.ddpClient)
				reject(e)
			}
		})
	}
	/**
	 * Like a subscribe, but automatically renews it upon reconnection
	 */
	autoSubscribe (publicationName: string, ...params: Array<any>): Promise<string> {
		return this.subscribe(publicationName, ...params)
		.then((subscriptionId: string) => {
			this._autoSubscriptions[subscriptionId] = {
				publicationName: publicationName,
				params: params
			}
			return subscriptionId
		})
	}
	unsubscribe (subscriptionId: string): void {
		this.ddp.ddpClient.unsubscribe(subscriptionId)
		delete this._autoSubscriptions[subscriptionId]
	}
	observe (collectionName: string): Observer {
		return this.ddp.ddpClient.observe(collectionName)
	}
	getCurrentTime (): number {
		return this._timeSync.currentTime()
	}
	hasSyncedTime (): boolean {
		return this._timeSync.isGood()
	}
	syncTimeQuality (): number | null {
		return this._timeSync.quality
	}
	setPingResponse (message: string) {
		this._watchDogPingResponse = message
	}
	private _setConnected (connected: boolean) {
		let prevConnected = this._connected
		this._connected = connected
		if (prevConnected !== connected) {
			if (connected) this.emit('connected')
			else this.emit('disconnected')
			this.emit('connectionChanged', connected)
			this._triggerPing()
		}
	}
	private _maybeSendInit (): Promise<any> {
		// If the connectionId has changed, we should report that to Core:
		if (this.ddp && this.ddp.connectionId !== this._sentConnectionId) {
			return this._sendInit()
		} else {
			return Promise.resolve()
		}
	}
	private _sendInit (): Promise<string> {
		if (!this.ddp) throw Error('Not connected to Core')

		let options: InitOptions = {
			type: this._coreOptions.deviceType,
			name: this._coreOptions.deviceName,
			connectionId: this.ddp.connectionId,
			parentDeviceId: (this._parent && this._parent.deviceId) || undefined,
			versions: this._coreOptions.versions
		}
		this._sentConnectionId = options.connectionId

		return new Promise<string>((resolve, reject) => {
			this.ddp.ddpClient.call(P.methods.initialize, [
				this._coreOptions.deviceId,
				this._coreOptions.deviceToken,
				options
			], (err: Error, id: string) => {
				if (err) {
					reject(err)
				} else {
					resolve(id)
				}
			})
		})
	}
	private _removeParent () {
		if (this._parent) this._parent.removeChild(this)
		this._parent = null
		this._setConnected(false)
	}
	private _setParent (parent: CoreConnection) {
		this._parent = parent
		parent.addChild(this)

		parent.on('connectionChanged', (connected) => { this._setConnected(connected) })
		this._setConnected(parent.connected)
	}
	private _watchDogCheck () {
		// Randomize a message and send it to Core. Core should then reply with sending a deciveCommand.
		let message = 'ping_' + Math.random() * 10000
		this.callMethod(PeripheralDeviceAPI.methods.pingWithCommand, [message])
		.catch(e => this.emit('error',e))

		return new Promise((resolve, reject) => {
			let i = 0
			let checkPingReply = () => {
				if (this._watchDogPingResponse === message) {
					// if we've got a good watchdog response, we can delay the pinging:
					this._triggerDelayPing()

					resolve()
				} else {
					i++
					if (i > 50) {
						reject()
					} else {
						setTimeout(checkPingReply, 300)
					}
				}
			}
			checkPingReply()
		}).then(() => {
			return
		})
	}
	private _renewAutoSubscriptions () {
		_.each(this._autoSubscriptions, (sub) => {
			this.subscribe(sub.publicationName, ...sub.params)
			.catch(e => this.emit('error', e))
		})
	}
	private _triggerPing () {
		if (!this._pingTimeout) {
			this._pingTimeout = setTimeout(() => {
				this._pingTimeout = null
				this._ping()
			}, 90 * 1000)
		}
	}
	private _triggerDelayPing () {
		// delay the ping:
		if (this._pingTimeout) {
			clearTimeout(this._pingTimeout)
			this._pingTimeout = null
		}
		this._triggerPing()
	}
	private _ping () {
		try {
			if (this.connected) {
				this.callMethod(PeripheralDeviceAPI.methods.ping)
				.catch(e => this.emit('error', e))
			}
		} catch (e) {
			this.emit('error', e)
		}
		if (this.connected) {
			this._triggerPing()
		}
	}
}

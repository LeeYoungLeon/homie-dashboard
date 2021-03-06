import {EventEmitter} from 'events'
import uuid from 'uuid'

import pkg from '../../package'
import {generateMessage, parseMessage, MESSAGE_TYPES} from '../../common/ws-messages'
import {hash} from './hash'
import {getStatistics} from './statistics'
import {VERSION, INFRASTRUCTURE} from '../../common/events'
import Tag from './infrastructure/tag'
import Floor from './infrastructure/floor'
import Room from './infrastructure/room'

import TagModel from '../models/tag'
import FloorModel from '../models/floor'
import RoomModel from '../models/room'
import SettingModel from '../models/setting'

/**
 * This class handles WebSocket clients
 * This is where every request gets parsed / responded
 @augments EventEmitter
 */
export default class Client extends EventEmitter {
  /**
   * Constructor
   @param {Object} opts
   @param {Object} opts.$deps
   @param {MqttClient} opts.mqttClient
   @param {Infrastructure} opts.infrastructure
   */
  constructor (opts) {
    super()

    this.$deps = opts.$deps
    this.ws = opts.ws
    this.mqttClient = opts.mqttClient
    this.infrastructure = opts.infrastructure

    this.ws.send(generateMessage({ type: MESSAGE_TYPES.EVENT, event: INFRASTRUCTURE, value: this.infrastructure.toJSON() }))
    this.ws.send(generateMessage({ type: MESSAGE_TYPES.EVENT, event: VERSION, value: pkg.version }))

    this.ws.on('message', data => {
      const message = parseMessage(data)
      this.onMessage(message)
    })

    this.ws.on('close', () => {
      this.emit('close')
    })
  }

  /**
   * This function sends a response
   @param {Object} request the initial request
   @param {} value value to respond
   */
  _sendResponse (request, value) {
    this.ws.send(generateMessage({ type: MESSAGE_TYPES.RESPONSE, id: request.id, value }))
  }

  /**
   * This function is called when we receive a message from the client
   @param {Object} message message received
   */
  async onMessage (message) {
    if (message.type !== MESSAGE_TYPES.REQUEST) return

    /* Handle requests */

    if (message.method === 'setState') {
      const deviceId = message.parameters.deviceId
      const nodeId = message.parameters.nodeId
      const property = message.parameters.property
      const value = message.parameters.value

      this.mqttClient.publish(`homie/${deviceId}/${nodeId}/${property}/set`, value, { qos: 1, retain: true })

      this._sendResponse(message, true)
    } else if (message.method === 'createTag') {
      const tagId = message.parameters.id

      const tag = new Tag()
      tag.id = tagId
      this.infrastructure.addTag(tag)
      tag.model = await TagModel.forge({ id: tagId }).save(null, { method: 'insert' })

      this._sendResponse(message, true)
    } else if (message.method === 'toggleTag') {
      const deviceId = message.parameters.deviceId
      const nodeId = message.parameters.nodeId
      const tagId = message.parameters.tagId
      const operationAdd = message.parameters.operationAdd

      const node = this.infrastructure.getDevice(deviceId).getNode(nodeId)
      const tag = this.infrastructure.getTag(tagId)

      if (operationAdd) {
        node.addTag(tag)
        await node.model.tags().attach(tag.model)
      } else {
        node.deleteTag(tag)
        await node.model.tags().detach(tag.model)
      }

      this._sendResponse(message, true)
    } else if (message.method === 'deleteTag') {
      const tagId = message.parameters.tagId
      const tag = this.infrastructure.getTag(tagId)

      await tag.model.destroy()
      this.infrastructure.deleteTag(tagId)

      this._sendResponse(message, true)
    } else if (message.method === 'addFloor') {
      const name = message.parameters.name

      const floor = new Floor()
      floor.model = await FloorModel.forge({ name, rooms_map: JSON.stringify([]) }).save()
      floor.id = floor.model.id
      floor.name = name
      this.infrastructure.addFloor(floor)

      this._sendResponse(message, true)
    } else if (message.method === 'changeNodeName') {
      const name = message.parameters.name
      const nodeData = message.parameters.node
      const device = this.infrastructure.getDevice(nodeData.device.id)
      const node = device.getNode(nodeData.id)
      node.name = name
      await node.model.save({ name: name })

      this._sendResponse(message, true)
    } else if (message.method === 'deleteFloor') {
      const floorId = message.parameters.floorId
      const floor = this.infrastructure.getFloor(floorId)

      await floor.model.destroy()
      this.infrastructure.deleteFloor(floorId)

      this._sendResponse(message, true)
    } else if (message.method === 'deleteRoom') {
      const floorId = message.parameters.floorId
      const roomId = message.parameters.roomId
      const floor = this.infrastructure.getFloor(floorId)
      const room = floor.getRoom(roomId)
      const tag = this.infrastructure.getTag(room.tagId)
      await room.model.destroy()
      floor.deleteRoom(room)
      floor.deleteMapRoom(room)
      this.infrastructure.deleteTag(tag)
      await floor.model.save({ rooms_map: JSON.stringify(floor.roomsMap) })
      await tag.model.destroy()

      this._sendResponse(message, true)
    } else if (message.method === 'addRoom') {
      const name = message.parameters.name

      const floorId = message.parameters.floor_id
      const tagId = `room:${uuid()}`
      const tag = new Tag()
      tag.id = tagId
      this.infrastructure.addTag(tag)
      tag.model = await TagModel.forge({ id: tagId }).save(null, { method: 'insert' })
      const floor = this.infrastructure.getFloor(floorId)
      const room = new Room()
      room.model = await RoomModel.forge({ name, floor_id: floorId, tag_id: tagId }).save()
      room.id = room.model.id
      room.name = name
      room.floor = floor
      room.tagId = tagId
      floor.addRoom(room)
      floor.addMapRoom({ w: 2, h: 2, x: 0, y: 0, i: room.tagId })
      await floor.model.save({ rooms_map: JSON.stringify(floor.roomsMap) })

      this._sendResponse(message, true)
    } else if (message.method === 'updateMap') {
      const floorId = message.parameters.floorId
      const map = message.parameters.map
      const floor = this.infrastructure.getFloor(floorId)
      floor.updateMap(map)
      await floor.model.save({rooms_map: JSON.stringify(floor.roomsMap)})

      this._sendResponse(message, true)
    } else if (message.method === 'getHomieEsp8266Settings') {
      this._sendResponse(message, this.$deps.settings['homie-esp8266'])
    } else if (message.method === 'getStatistics') {
      const {deviceId, nodeId, propertyId, type, granularity, range} = message.parameters

      const result = await getStatistics({
        deviceId, nodeId, propertyId, type, granularity, range
      })
      this._sendResponse(message, result)
    } else if (message.method === 'saveAutomationScript') {
      const blocklyXml = message.parameters.blocklyXml
      const script = message.parameters.script

      this.infrastructure.setAutomation({
        xml: blocklyXml,
        script
      })

      this._sendResponse(message, true)
    } else if (message.method === 'updatePassword') {
      const {password} = message.parameters

      const hashed = await hash(password)

      await SettingModel.forge({ key: 'password' }).save({ value: hashed })

      this._sendResponse(message, true)
    }
  }
}

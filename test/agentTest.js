const ip = require('ip').address();
const assert = require('assert');
const fs = require('fs');
const sinon = require('sinon');
const request = require('co-request');
const parse = require('xml-parser');
const expect = require('expect.js');
const R = require('ramda');

// Imports - Internal
const lokijs = require('../src/lokijs')
const dataStorage = require('../src/dataStorage')
const config = require('../src/config/config');
const adapter = require('../src/simulator/adapter');
const device = require('../src/simulator/device');
const fileServer = require('../src/simulator/fileserver');
const { filePort, machinePort } = config.app.simulator;
const { start, stop } = require('../src/agent');
const xmlToJSON = require('../src/xmlToJSON');
const common = require('../src/common');

//constants
const schemaPtr = lokijs.getSchemaDB()
const cbPtr = dataStorage.circularBuffer
const bufferSize = config.app.agent.bufferSize

describe('Agent', () => {
  let deviceT;
  let filesT;

  before(function *setup() {
    //adapter.start();
    yield start();
    yield new Promise((success) => (deviceT = device.listen(machinePort, ip, success)));
    yield new Promise((success) => (filesT = fileServer.listen(filePort, ip, success)));
  });


  after(() => {
    stop();
    deviceT.close();
    filesT.close();
  });

  it('returns error on request /bad/path/', function *(done){
    const path = '/bad/path/'
    const { body } = yield request(`http://${ip}:7000${path}`)
    
    const obj = parse(body)
    const { root } = obj
    const child = root.children[1].children[0]
    const errorCode = child.attributes.errorCode
    const content = child.content

    expect(root.name).to.eql('MTConnectError')
    expect(errorCode).to.eql('UNSUPPORTED')
    expect(content).to.eql(`The following path is invalid: ${path}.`)
    done()
  })

  it('returns error on request /LinuxCNC/current/blah', function *(done) {
    const path = '/LinuxCNC/current/blah'
    const { body } = yield request(`http://${ip}:7000${path}`)
    
    const obj = parse(body)
    const { root } = obj
    const child = root.children[1].children[0]
    const errorCode = child.attributes.errorCode
    const content = child.content

    expect(root.name).to.eql('MTConnectError')
    expect(errorCode).to.eql('UNSUPPORTED')
    expect(content).to.eql(`The following path is invalid: ${path}.`)
    done()
  })
});

describe('Bad device', ()=>{
  let deviceT
  let filesT
  before(function *() {
    yield start();
    yield new Promise((success) => (deviceT = device.listen(machinePort, ip, success)));
    yield new Promise((success) => (filesT = fileServer.listen(filePort, ip, success)));
  })

  after(()=> {
    stop()
    deviceT.close()
    filesT.close()
  })

  it('returns error if bad device', function *(done){
    const device = 'LinuxCN'
    const { body } = yield request(`http://${ip}:7000/${device}/probe`)
    const obj = parse(body)
    const { root } = obj
    const child = root.children[1].children[0]
    const errorCode = child.attributes.errorCode
    const content = child.content

    expect(root.name).to.eql('MTConnectError')
    expect(errorCode).to.eql('NO_DEVICE')
    expect(content).to.eql(`Could not find the device ${device}.`)
    done()
  })
})

describe('test assetStorage', () => {
  const url = `http://${ip}:7000/assets`
  const maxAssets = 4
  let stub
  
  before(() => {
    schemaPtr.clear()
    dataStorage.assetBuffer.size = maxAssets
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    dataStorage.hashLast.clear()
    const xml = fs.readFileSync('./public/VMC-3Axis.xml', 'utf8')
    const jsonFile = xmlToJSON.xmlToJSON(xml)
    lokijs.insertSchemaToDB(jsonFile)
    stub = sinon.stub(common, 'getAllDeviceUuids')
    stub.returns(['000'])
    start()
  })

  after(() => {
    stop()
    dataStorage.assetBuffer.size = bufferSize
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    schemaPtr.clear()
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.hashLast.clear()
    stub.restore()
  })

  it('should return assetBufferSize and assetCount', (done) => {
    
    const maxAssetsNow = dataStorage.assetBuffer.size
    const assetCount = dataStorage.hashAssetCurrent._count
    assert(maxAssets === maxAssetsNow)
    assert(assetCount === 0)
    done()
  })

  it('adds new asset and return assetCount=1', function *(done){
    const reqPath = '/assets/123?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST</CuttingTool>'
    })
    
    assert(body === '<success/>\r\n')
    assert(dataStorage.hashAssetCurrent._count === 1)
    done()
  })

  it('returns newly added asset', function*(done){

    const { body } = yield request(url)
    const obj = parse(body)
    const { root } = obj
    const child = root.children[0].attributes
    const child1 = root.children[1].children[0]

    assert(Number(child.assetBufferSize) === maxAssets)
    assert(dataStorage.hashAssetCurrent._count === Number(child.assetCount))
    assert(child1.name === 'CuttingTool')
    assert(child1.content === 'TEST')
    done()
  })

  it('device should generate change event', function *(done){

    const { body } = yield request(`http://${ip}:7000/current`)
    const obj = parse(body)
    const { root } = obj
    const assetChanged = root.children[1].children[0].children[0].children[0].children[1]
    
    assert(assetChanged.content === '123')
    //assert(assetChanged.assetType === 'CuttingTool') // there is no assettype property yet
    done()
  })
})

describe('testAssetBuffer', (done) => {
  const url = `http://${ip}:7000/assets`
  const maxAssets = 4
  let stub
  const success = '<success/>\r\n'
  const failed = '<failed/>\r\n'
  
  before(() => {
    schemaPtr.clear()
    dataStorage.assetBuffer.size = maxAssets
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    dataStorage.hashLast.clear()
    const xml = fs.readFileSync('./public/VMC-3Axis.xml', 'utf8')
    const jsonFile = xmlToJSON.xmlToJSON(xml)
    lokijs.insertSchemaToDB(jsonFile)
    stub = sinon.stub(common, 'getAllDeviceUuids')
    stub.returns(['000'])
    start()
  })

  after(() => {
    stop()
    dataStorage.assetBuffer.size = bufferSize
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    schemaPtr.clear()
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.hashLast.clear()
    stub.restore()
  })

  it('assetBufferSize should be 4 and assetCount 0', function *(done) {

    assert(maxAssets === dataStorage.assetBuffer.size)
    assert(dataStorage.assetBuffer.length === 0)
    done()
  })
  
  it('assetCount should be 1 once we add first asset', function *(done){
    const reqPath = '/assets/1?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST 1</CuttingTool>'
    })

    assert(body === success)
    const assetArr = dataStorage.assetBuffer.toArray()
    assert(assetArr.length === 1)
    assert(assetArr[0].assetType === 'CuttingTool')
    done()
  })

  it('returns newly added asset on request', function *(done) {
    const reqPath = '/assets/1?type=CuttingTool&device=VMC-3Axis'  

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(Number(header.assetCount) === 1)
    assert(assets.length === 1)
    assert(assets[0].content === 'TEST 1')
    done()
  })

  it('make sure replace work properly', function *(done){
    const reqPath = '/assets/1?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST 1</CuttingTool>'
    })

    assert(body === failed)
    const assetArr = dataStorage.assetBuffer.toArray()
    assert(assetArr.length === 1)
    assert(assetArr[0].assetType === 'CuttingTool')
    done()
  })

  it('returns assetCount=2 after posting another asset', function*(done){
    const reqPath = '/assets/2?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST 2</CuttingTool>'
    })

    assert(body === success)
    const assetArr = dataStorage.assetBuffer.toArray()
    assert(assetArr.length === 2)
    R.map((asset) => {
      assert(asset.assetType === 'CuttingTool')
    }, assetArr)
    done()
  })

  it('prints newly added asset on request', function *(done) {
    const reqPath = '/assets/2?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(Number(header.assetCount) === 2)
    assert(assets.length === 1)
    assert(assets[0].content === 'TEST 2')
    done()
  })

  it('return assetCount=3 after posting 3rd asset', function*(done){
    const reqPath = '/assets/3?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST 3</CuttingTool>'
    })

    assert(body === success)
    const assetArr = dataStorage.assetBuffer.toArray()
    assert(assetArr.length === 3)
    R.map((asset) => {
      assert(asset.assetType === 'CuttingTool')
    }, assetArr)
    done()
  })

  it('prints to the screen recently added asset if requested', function*(done){
    const reqPath = '/assets/3?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(Number(header.assetCount) === 3)
    assert(assets.length === 1)
    assert(assets[0].content === 'TEST 3')
    done()
  })

  it('returns assetCount=4 if posted 4th asset', function*(done){
    const reqPath = '/assets/4?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST 4</CuttingTool>'
    })

    assert(body === success)
    const assetArr = dataStorage.assetBuffer.toArray()
    assert(assetArr.length === 4)
    R.map((asset) => {
      assert(asset.assetType === 'CuttingTool')
    },assetArr)
    done()
  }) 

  it('prints to the screen newly added asset if requested', function*(done){
    const reqPath = '/assets/4?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(Number(header.assetCount) === 4)
    assert(assets.length === 1)
    assert(assets[0].content === 'TEST 4')
    done()
  })

  it('test multiple assets get', function*(done){
    const reqPath = '/assets'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children
    let number = 4

    assert(Number(header.assetCount) === 4)
    assert(assets.length === 4)
    R.map((asset) => {
      assert(asset.content === `TEST ${number--}`)
    }, assets)
    done()
  })

  it('test multiple assets get with filters type and device', function*(done){
    const reqPath = '/assets?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children
    let number = 4

    assert(Number(header.assetCount) === 4)
    assert(assets.length === 4)
    R.map((asset) => {
      assert(asset.content === `TEST ${number--}`)
    }, assets)
    done()
  })

  it('test multiple assets get with filters type, device and count', function*(done){
    const reqPath = '/assets?type=CuttingTool&device=VMC-3Axis&count=2'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(Number(header.assetCount) === 4)
    assert(assets.length === 2)
    assert(assets[0].content === 'TEST 4')
    assert(assets[1].content === 'TEST 3')
    done()
  })

  it('after adding 5th asset assetCount should stay at 4', function*(done){
    const reqPath = '/assets/5?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST 5</CuttingTool>'
    })

    assert(body === success)
    const assetArr = dataStorage.assetBuffer.toArray()
    assert(assetArr.length === 4)
    R.map((asset) => {
      assert(asset.assetType === 'CuttingTool')
    }, assetArr)
    done()
  })

  it('prints newly added asset if requested', function*(done){
    const reqPath = '/assets/5?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(assets.length === 1)
    assert(Number(header.assetCount) === maxAssets)
    assert(assets[0].content === 'TEST 5')
    done()
  })

  it('returns error ASSET_NOT_FOUND when requested assets/1', function*(done){
    const reqPath = '/assets/1'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const error = root.children[1].children[0]
    const errorCode = error.attributes.errorCode
    
    assert(error.content === 'Could not find asset: 1')
    assert(errorCode === 'ASSET_NOT_FOUND')
    done()
  })

  it('should return asset#2 if requested', function*(done){
    const reqPath = '/assets/2'

    const { body } =yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(assets.length === 1)
    assert(Number(header.assetCount) === maxAssets)
    assert(assets[0].content === 'TEST 2')
    done()
  })

  it('rewrites value of existing asset', function*(done){
    const reqPath = '/assets/3?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST 6</CuttingTool>'
    })

    assert(body === success)
    const assets = dataStorage.assetBuffer.toArray()
    assert(assets.length === 4)
    R.map((asset) => {
      assert(asset.assetType === 'CuttingTool')
    }, assets)
    done()
  })

  it('returns new value if request assets/3', function*(done){
    const reqPath = '/assets/3?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(assets.length === 1)
    assert(Number(header.assetCount) === maxAssets)
    assert(assets[0].content === 'TEST 6')
    done()
  })

  it('should change value of asset#2 without inserting new entry to assetBuffer', function*(done){
    const reqPath = '/assets/2?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST 7</CuttingTool>'
    })

    assert(body === success)
    const assets = dataStorage.assetBuffer.toArray()
    assert(assets.length === maxAssets)
    R.map((asset)=>{
      assert(asset.assetType === 'CuttingTool')
    }, assets)
    done()
  })

  it('should insert new asset to assetBuffer', function*(done){
    const reqPath = '/assets/6?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request({
      url: `http://0.0.0.0:7000${reqPath}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml'
      },
      body: '<CuttingTool>TEST 8</CuttingTool>'
    })

    assert(body === success)
    const assets = dataStorage.assetBuffer.toArray()
    assert(assets.length === maxAssets)
    R.map((asset) => {
      assert(asset.assetType === 'CuttingTool')
    }, assets)
    done()
  })

  it('should print to the screen newly added asset#3', function*(done){
    const reqPath = '/assets/6?type=CuttingTool&device=VMC-3Axis'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(assets.length === 1)
    assert(Number(header.assetCount) === maxAssets)
    assert(assets[0].content === 'TEST 8')
    done()
  })

  it('should return ASSET_NOT_FOUND when requesting asset#4', function*(done){
    const reqPath = '/assets/4'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const error = root.children[1].children[0]
    const errorCode = error.attributes.errorCode
    
    assert(error.content === 'Could not find asset: 4')
    assert(errorCode === 'ASSET_NOT_FOUND')
    done()
  })
})

describe('testAssetError()', () => {
  before(() => {
    schemaPtr.clear()
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    dataStorage.hashLast.clear()
    const xml = fs.readFileSync('./public/VMC-3Axis.xml', 'utf8')
    const jsonFile = xmlToJSON.xmlToJSON(xml)
    lokijs.insertSchemaToDB(jsonFile)
    stub = sinon.stub(common, 'getAllDeviceUuids')
    stub.returns(['000'])
    start()
  })

  after(() => {
    stop()
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    schemaPtr.clear()
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.hashLast.clear()
    stub.restore()
  })

  it('should return errorCode ASSET_NOT_FOUND if request /assets/123', function*(done){
    const { body } = yield request(`http://${ip}:7000/assets/123`)
    const obj = parse(body)
    const { root } = obj
    const error = root.children[1].children[0]
    const errorCode = error.attributes.errorCode
    
    assert(error.content === 'Could not find asset: 123')
    assert(errorCode === 'ASSET_NOT_FOUND')
    done()
  })
})

describe('testAdapterAddAsset', () => {
  const str = 'TIME|@ASSET@|111|CuttingTool|<CuttingTool>TEST 1</CuttingTool>'

  before(() => {
    schemaPtr.clear()
    dataStorage.assetBuffer.size = 4
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    dataStorage.hashLast.clear()
    const xml = fs.readFileSync('./public/VMC-3Axis.xml', 'utf8')
    const jsonFile = xmlToJSON.xmlToJSON(xml)
    lokijs.insertSchemaToDB(jsonFile)
    stub = sinon.stub(common, 'getAllDeviceUuids')
    stub.returns(['000'])
    start()
  })

  after(() => {
    stop()
    dataStorage.assetBuffer.size = bufferSize
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    schemaPtr.clear()
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.hashLast.clear()
    stub.restore()
  })

  it('should return assetCount=1 after insering new asset', (done) => {
    const jsonObj = common.inputParsing(str, '000')
    lokijs.dataCollectionUpdate(jsonObj, '000')

    assert(dataStorage.assetBuffer.size === 4)
    assert(dataStorage.assetBuffer.length === 1)
    done()
  })

  it('returns newly added asset on request', function*(done){
    const { body } = yield request(`http://${ip}:7000/assets/111`)
    const obj = parse(body)
    const { root } = obj
    const header = root.children[0].attributes
    const assets = root.children[1].children

    assert(assets.length === 1)
    assert(Number(header.assetCount) === dataStorage.assetBuffer.length)
    assert(assets[0].content === 'TEST 1')
    done()
  })
})

describe('testMultiLineAsset()', () => {
  const newAsset = 'TIME|@ASSET@|111|CuttingTool|--multiline--AAAA\n' +
                    '<CuttingTool>\n' +
                      ' <CuttingToolXXX>TEST 1</CuttingToolXXX>\n' +
                      ' Some Test\n' +
                      ' <Extra>XXX</Extra>\n' + 
                    '</CuttingTool>\n' +
                    '--multiline--AAAA\n'
  //const assetsArr = [newAsset1, newAsset2, newAsset3]
  before(() => {
    schemaPtr.clear()
    dataStorage.assetBuffer.size = 4
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    dataStorage.hashLast.clear()
    const xml = fs.readFileSync('./public/VMC-3Axis.xml', 'utf8')
    const jsonFile = xmlToJSON.xmlToJSON(xml)
    lokijs.insertSchemaToDB(jsonFile)
    stub = sinon.stub(common, 'getAllDeviceUuids')
    stub.returns(['000'])
    start()
  })

  after(() => {
    stop()
    dataStorage.assetBuffer.size = bufferSize
    dataStorage.assetBuffer.fill(null).empty()
    dataStorage.hashAssetCurrent.clear()
    schemaPtr.clear()
    cbPtr.fill(null).empty()
    dataStorage.hashCurrent.clear()
    dataStorage.hashLast.clear()
    stub.restore()
  })

  it('it should accept multiline assets', () => {
    const json = common.inputParsing(newAsset, '000')
    lokijs.dataCollectionUpdate(json, '000')
    // R.map((asset) => {
    //   const json = common.inputParsing(asset, '000')
    //   lokijs.dataCollectionUpdate(json, '000')
    // }, assetsArr)

    assert(dataStorage.assetBuffer.size === 4)
    assert(dataStorage.assetBuffer.length === 1)
  })

  it('should return newly added asset when request /assets/111', function*(done){
    const reqPath = '/assets/111'

    const { body } = yield request(`http://${ip}:7000${reqPath}`)
    const obj = parse(body)
    const { root } = obj
    const child = root.children[1].children[0].attributes
    done()
  })
})

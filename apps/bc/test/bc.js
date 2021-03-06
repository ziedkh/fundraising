/* eslint-disable no-undef */
const { assertRevert } = require('@aragon/test-helpers/assertThrow')
const getBalance = require('@aragon/test-helpers/balance')(web3)
const assertEvent = require('@aragon/test-helpers/assertEvent')
const timeTravel = require('@aragon/test-helpers/timeTravel')(web3)
const blockNumber = require('@aragon/test-helpers/blockNumber')(web3)
const { hash } = require('eth-ens-namehash')

const getEvent = (receipt, event, arg) => {
  return receipt.logs.filter(l => l.event === event)[0].args[arg]
}
const getTimestamp = receipt => {
  return web3.eth.getBlock(receipt.receipt.blockNumber).timestamp
}

const Kernel = artifacts.require('Kernel')
const ACL = artifacts.require('ACL')
const EVMScriptRegistryFactory = artifacts.require('EVMScriptRegistryFactory')
const DAOFactory = artifacts.require('DAOFactory')
const MiniMeToken = artifacts.require('MiniMeToken')
const TokenManager = artifacts.require('TokenManager')
const Pool = artifacts.require('Pool')
const Controller = artifacts.require('SimpleMarketMakerController')
const Formula = artifacts.require('BancorFormula.sol')
const BancorCurve = artifacts.require('BancorCurve')
const EtherTokenConstantMock = artifacts.require('EtherTokenConstantMock')
const TokenMock = artifacts.require('TokenMock')
const ForceSendETH = artifacts.require('ForceSendETH')

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000'

contract('BancorCurve app', accounts => {
  let factory, dao, acl, token, pBase, cBase, bBase, tBase, pool, tokenManager, controller, formula, curve, token1, token2, token3
  let ETH,
    APP_MANAGER_ROLE,
    MINT_ROLE,
    BURN_ROLE,
    UPDATE_FEE_ROLE,
    UPDATE_GAS_ROLE,
    ADD_COLLATERAL_TOKEN_ROLE,
    CREATE_BUY_ORDER_ROLE,
    CREATE_SELL_ORDER_ROLE,
    TRANSFER_ROLE

  // let UPDATE_VAULT_ROLE, UPDATE_POOL_ROLE, ADD_TOKEN_TAP_ROLE, REMOVE_TOKEN_TAP_ROLE, UPDATE_TOKEN_TAP_ROLE, WITHDRAW_ROLE, TRANSFER_ROLE

  const POOL_ID = hash('pool.aragonpm.eth')
  const TOKEN_MANAGER_ID = hash('token-manager.aragonpm.eth')
  const CONTROLLER_ID = hash('controller.aragonpm.eth')
  const BANCOR_CURVE_ID = hash('vault.aragonpm.eth')

  const INITIAL_ETH_BALANCE = 500
  const INITIAL_TOKEN_BALANCE = 1000

  const VIRTUAL_SUPPLIES = [2, 3, 4]
  const VIRTUAL_BALANCES = [1, 3, 3]
  const RESERVE_RATIOS = [200000, 300000, 500000]
  const FEE_PERCENT = 10000
  const BUY_GAS = 0
  const SELL_GAS = 0
  const BLOCKS_IN_BATCH = 10
  const PPM = 1000000

  const root = accounts[0]
  const authorized = accounts[1]
  const unauthorized = accounts[2]

  const initialize = async _ => {
    // DAO
    const dReceipt = await factory.newDAO(root)
    dao = await Kernel.at(getEvent(dReceipt, 'DeployDAO', 'dao'))
    acl = await ACL.at(await dao.acl())
    await acl.createPermission(root, dao.address, APP_MANAGER_ROLE, root, { from: root })
    // token
    token = await MiniMeToken.new(NULL_ADDRESS, NULL_ADDRESS, 0, 'Bond', 18, 'BON', false)
    // pool
    const pReceipt = await dao.newAppInstance(POOL_ID, pBase.address, '0x', false)
    pool = await Pool.at(getEvent(pReceipt, 'NewAppProxy', 'proxy'))
    // market maker controller
    const cReceipt = await dao.newAppInstance(CONTROLLER_ID, cBase.address, '0x', false)
    controller = await Controller.at(getEvent(cReceipt, 'NewAppProxy', 'proxy'))
    // token manager
    const tReceipt = await dao.newAppInstance(TOKEN_MANAGER_ID, tBase.address, '0x', false)
    tokenManager = await TokenManager.at(getEvent(tReceipt, 'NewAppProxy', 'proxy'))
    // bancor-curve
    const bReceipt = await dao.newAppInstance(BANCOR_CURVE_ID, bBase.address, '0x', false)
    curve = await BancorCurve.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))
    // permissions
    await acl.createPermission(curve.address, pool.address, TRANSFER_ROLE, root, { from: root })
    await acl.createPermission(curve.address, tokenManager.address, MINT_ROLE, root, { from: root })
    await acl.createPermission(curve.address, tokenManager.address, BURN_ROLE, root, { from: root })
    await acl.createPermission(authorized, curve.address, UPDATE_GAS_ROLE, root, { from: root })
    await acl.createPermission(authorized, curve.address, UPDATE_FEE_ROLE, root, { from: root })
    await acl.createPermission(authorized, curve.address, ADD_COLLATERAL_TOKEN_ROLE, root, { from: root })
    await acl.createPermission(authorized, curve.address, CREATE_BUY_ORDER_ROLE, root, { from: root })
    await acl.createPermission(authorized, curve.address, CREATE_SELL_ORDER_ROLE, root, { from: root })
    // collaterals
    await forceSendETH(authorized, INITIAL_ETH_BALANCE)
    token1 = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)
    token2 = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)
    token3 = await TokenMock.new(unauthorized, INITIAL_TOKEN_BALANCE)
    // allowances
    await token1.approve(curve.address, INITIAL_TOKEN_BALANCE, { from: authorized })
    await token2.approve(curve.address, INITIAL_TOKEN_BALANCE, { from: authorized })
    await token3.approve(curve.address, INITIAL_TOKEN_BALANCE, { from: unauthorized })
    // initializations
    await token.changeController(tokenManager.address)
    await tokenManager.initialize(token.address, true, 0)
    await pool.initialize()

    await controller.initialize(pool.address, curve.address)
    await curve.initialize(controller.address, tokenManager.address, formula.address, BLOCKS_IN_BATCH)
    await curve.updateFee(FEE_PERCENT, { from: authorized })
    await curve.updateGas(BUY_GAS, SELL_GAS, { from: authorized })
    await curve.addCollateralToken(ETH, VIRTUAL_SUPPLIES[0], VIRTUAL_BALANCES[0], RESERVE_RATIOS[0], { from: authorized })
    await curve.addCollateralToken(token1.address, VIRTUAL_SUPPLIES[1], VIRTUAL_BALANCES[1], RESERVE_RATIOS[1], { from: authorized })
    await curve.addCollateralToken(token2.address, VIRTUAL_SUPPLIES[2], VIRTUAL_BALANCES[2], RESERVE_RATIOS[2], { from: authorized })
  }

  const forceSendETH = async (to, value) => {
    // Using this contract ETH will be send by selfdestruct which always succeeds
    const forceSend = await ForceSendETH.new()
    return forceSend.sendByDying(to, { value })
  }

  before(async () => {
    // factory
    const kBase = await Kernel.new(true) // petrify immediately
    const aBase = await ACL.new()
    const rFact = await EVMScriptRegistryFactory.new()
    factory = await DAOFactory.new(kBase.address, aBase.address, rFact.address)
    // formula
    formula = await Formula.new()
    // base contracts
    pBase = await Pool.new()
    cBase = await Controller.new()
    tBase = await TokenManager.new()
    bBase = await BancorCurve.new()
    // constants
    ETH = await (await EtherTokenConstantMock.new()).getETHConstant()
    APP_MANAGER_ROLE = await kBase.APP_MANAGER_ROLE()
    TRANSFER_ROLE = await pBase.TRANSFER_ROLE()
    MINT_ROLE = await tBase.MINT_ROLE()
    BURN_ROLE = await tBase.BURN_ROLE()
    UPDATE_GAS_ROLE = await bBase.UPDATE_GAS_ROLE()
    UPDATE_FEE_ROLE = await bBase.UPDATE_FEE_ROLE()
    ADD_COLLATERAL_TOKEN_ROLE = await bBase.ADD_COLLATERAL_TOKEN_ROLE()
    CREATE_BUY_ORDER_ROLE = await bBase.CREATE_BUY_ORDER_ROLE()
    CREATE_SELL_ORDER_ROLE = await bBase.CREATE_SELL_ORDER_ROLE()
  })

  beforeEach(async () => {
    await initialize()
  })

  context('> #deploy', () => {
    it('> it should deploy', async () => {
      await BancorCurve.new()
    })
  })

  context('> #initialize', () => {
    context('> initialization parameters are correct', () => {
      it('it should initialize contract', async () => {
        assert.equal(await curve.pool(), pool.address)
        assert.equal(await curve.token(), token.address)
        assert.equal(await token.transfersEnabled(), true)
        assert.equal(await curve.batchBlocks(), BLOCKS_IN_BATCH)
        assert.equal(await curve.collateralTokensLength(), 3)

        assert.equal(await curve.collateralTokens(0), ETH)
        assert.equal(await curve.collateralTokens(1), token1.address)
        assert.equal(await curve.collateralTokens(2), token2.address)

        assert.equal(await controller.isCollateralToken(ETH), true)
        assert.equal(await controller.isCollateralToken(token1.address), true)
        assert.equal(await controller.isCollateralToken(token2.address), true)

        assert.equal(await controller.virtualSupply(ETH), VIRTUAL_SUPPLIES[0])
        assert.equal(await controller.virtualSupply(token1.address), VIRTUAL_SUPPLIES[1])
        assert.equal(await controller.virtualSupply(token2.address), VIRTUAL_SUPPLIES[2])
        assert.equal(await controller.virtualBalance(ETH), VIRTUAL_BALANCES[0])
        assert.equal(await controller.virtualBalance(token1.address), VIRTUAL_BALANCES[1])
        assert.equal(await controller.virtualBalance(token2.address), VIRTUAL_BALANCES[2])
        assert.equal(await controller.reserveRatio(ETH), RESERVE_RATIOS[0])
        assert.equal(await controller.reserveRatio(token1.address), RESERVE_RATIOS[1])
        assert.equal(await controller.reserveRatio(token2.address), RESERVE_RATIOS[2])
      })
    })

    //   context('> initialization parameters are not correct', () => {
    //     it('it should revert', async () => {

    //     })
    //   })

    //   it('it should revert on re-initialization', async () => {
    //     await assertRevert(() => curve.initialize(controller.address, tokenManager.address, formula.address, 1, { from: root }))
    //   })
  })
  context('> #test', () => {
    it('it should work', async () => {
      assert.equal(await controller.reserveRatio(ETH), RESERVE_RATIOS[0])
      assert.equal(await controller.reserveRatio(token1.address), RESERVE_RATIOS[1])
      assert.equal(await controller.reserveRatio(token2.address), RESERVE_RATIOS[2])
      assert.equal(await controller.virtualSupply(ETH), VIRTUAL_SUPPLIES[0])
      assert.equal(await controller.virtualSupply(token1.address), VIRTUAL_SUPPLIES[1])
      assert.equal(await controller.virtualSupply(token2.address), VIRTUAL_SUPPLIES[2])
      assert.equal(await controller.virtualBalance(ETH), VIRTUAL_BALANCES[0])
      assert.equal(await controller.virtualBalance(token1.address), VIRTUAL_BALANCES[1])
      assert.equal(await controller.virtualBalance(token2.address), VIRTUAL_BALANCES[2])
    })
  })

  context('> #createBuyOrder', () => {
    context('> sender has CREATE_BUY_ORDER_ROLE', () => {
      context('> and collateral is whitelisted', () => {
        context('> and value is not zero', () => {
          it('it should create buy order', async () => {
            let currentBlock = await blockNumber()
            console.log({ currentBlock })
            let currentBatchId = await curve.getCurrentBatchId()
            console.log({ currentBatchId: currentBatchId.toNumber(10) })
            // await stopMining()
            const receipt = await curve.createBuyOrder(authorized, token1.address, 10, { from: authorized })
            // await startMining()
            // console.log(receipt)
            // console.log(receipt.logs)
            assertEvent(receipt, 'NewBuyOrder')

            NewBuyOrder = receipt.logs.find(l => l.event === 'NewBuyOrder')
            let batchNumber = NewBuyOrder ? NewBuyOrder.args.batchId.toNumber() : new Error('No Buy Order')
            console.log({ batchNumber })
            // currentBlock = await blockNumber()
            // console.log({ currentBlock })

            await increaseBlocks(BLOCKS_IN_BATCH)

            await printBatch(curve, batchNumber)

            const _receipt = await curve.createBuyOrder(authorized, token1.address, 10, { from: authorized })
            // console.log(_receipt)
            // console.log(_receipt.logs)

            NewBuyOrder = _receipt.logs.find(l => l.event === 'NewBuyOrder')
            let _batchNumber = NewBuyOrder ? NewBuyOrder.args.batchId.toNumber() : new Error('No Buy Order')
            console.log({ _batchNumber })

            assertEvent(_receipt, 'NewBuyOrder')

            // const batch = await curve.getBatch(token1.address, batchNumber)
            // console.log({ batch })

            const claim = await curve.claimBuy(authorized, token1.address, batchNumber)
            // console.log(claim)
            // console.log(claim.logs)
            assertEvent(claim, 'ReturnBuy')

            // tons of others assert stuff here
          })
        })

        context('> but value is zero', () => {
          it('it should revert', async () => {
            await assertRevert(() => curve.createBuyOrder(authorized, token1.address, 0, { from: authorized }))
          })
        })
      })
      context('> but collateral is not whitelisted', () => {
        it('it should revert', async () => {
          const unlisted = await TokenMock.new(authorized, INITIAL_TOKEN_BALANCE)
          await unlisted.approve(curve.address, INITIAL_TOKEN_BALANCE, { from: authorized })

          await assertRevert(() => curve.createBuyOrder(authorized, unlisted.address, 10, { from: authorized }))
        })
      })
    })
    context('> sender does not have CREATE_BUY_ORDER_ROLE', () => {
      it('it should revert', async () => {
        await assertRevert(() => curve.createBuyOrder(unauthorized, token3.address, 10, { from: unauthorized }))
      })
    })
  })

  // context('> #createSellOrder', () => {
  //   context('> sender has CREATE_SELL_ORDER_ROLE', () => {
  //     context('> and collateral is whitelisted', () => {
  //       context('> and amount is not zero', () => {
  //         context('> and sender has sufficient funds', () => {
  //           it('it should create sell order', async () => {

  //             // assertEvent(receipt, 'NewSellOrder')
  //             // tons of others assert stuff here
  //           })
  //         })

  //         context('> but sender does not have sufficient funds', () => {
  //           it('it should revert', async () => {
  //           })
  //         })
  //       })

  //       context('> but amount is zero', () => {
  //         it('it should revert', async () => {
  //         })
  //       })
  //     })
  //     context('> but collateral is not whitelisted', () => {
  //       it('it should revert', async () => {

  //       })
  //     })

  //   })
  //   context('> sender does not have CREATE_SELL_ORDER_ROLE', () => {
  //     it('it should revert', async () => {
  //     })
  //   })
  // })

  context('> #claimBuyOrder', () => {
    it('it should return claimed buy order', async () => {
      const receipt1 = await curve.createBuyOrder(authorized, token1.address, 10, { from: authorized })
      // const receipt2 = await curve.createBuyOrder(authorized, token1.address, 10, { from: authorized })

      // const batchId = receipt1.logs[0].args.batchId

      const cleared1 = await curve.clearBatches()

      // throw new Error()

      assertEvent(receipt1, 'NewBuyOrder')
      // tons of others assert stuff here
    })
  })
})

async function printBatch(curve, batchNumber) {
  const tokens = await curve.collateralTokensLength()
  await _printBatch(curve, batchNumber, tokens.toNumber())
}

async function _printBatch(curve, batchNumber, len, key = 0) {
  const PPM = 1000000
  console.log({ len, key })
  if (key === len) return
  const tokenAddress = await curve.collateralTokens(key)
  let [
    init,
    buysCleared,
    sellsCleared,
    cleared,
    poolBalance,
    totalSupply,
    totalBuySpend,
    totalBuyReturn,
    totalSellSpend,
    totalSellReturn,
  ] = await curve.getBatch(tokenAddress, batchNumber)
  console.log({
    tokenAddress,
    init,
    buysCleared,
    sellsCleared,
    cleared,
    poolBalance,
    totalSupply,
    totalBuySpend,
    totalBuyReturn,
    totalSellSpend,
    totalSellReturn,
  })
  let staticPrice = await curve.getPricePPM(tokenAddress, totalSupply, poolBalance)
  console.log({ staticPrice: staticPrice.toNumber() })
  let resultOfSell = totalSellSpend.mul(staticPrice).div(PPM)
  console.log({ resultOfSell: resultOfSell.toString(10) })
  let resultOfBuy = totalBuySpend.mul(PPM).div(staticPrice)
  console.log({ resultOfBuy: resultOfBuy.toString(10) })
  let remainingBuy = totalBuySpend.sub(resultOfSell)
  console.log({ remainingBuy: remainingBuy.toString(10) })

  await _printBatch(curve, batchNumber, len, key + 1)
}

function increaseBlocks(blocks) {
  return new Promise((resolve, reject) => {
    increaseBlock().then(() => {
      blocks -= 1
      if (blocks === 0) {
        resolve()
      } else {
        increaseBlocks(blocks).then(resolve)
      }
    })
  })
}

function stopMining() {
  return new Promise((resolve, reject) => {
    web3.currentProvider.sendAsync(
      {
        jsonrpc: '2.0',
        method: 'miner_stop',
        id: 12346,
      },
      (err, result) => {
        if (err) reject(err)
        resolve(result)
      }
    )
  })
}

function startMining() {
  return new Promise((resolve, reject) => {
    web3.currentProvider.sendAsync(
      {
        jsonrpc: '2.0',
        method: 'miner_start',
        id: 12347,
      },
      (err, result) => {
        if (err) reject(err)
        resolve(result)
      }
    )
  })
}

function increaseBlock() {
  return new Promise((resolve, reject) => {
    web3.currentProvider.sendAsync(
      {
        jsonrpc: '2.0',
        method: 'evm_mine',
        id: 12345,
      },
      (err, result) => {
        if (err) reject(err)
        resolve(result)
      }
    )
  })
}

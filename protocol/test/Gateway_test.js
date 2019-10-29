// eslint-disable-next-line @typescript-eslint/no-var-requires
const h = require('chainlink').helpers

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {expectRevert} = require('openzeppelin-test-helpers')

const BN = web3.utils.BN

const PAYPAL_RECEIVER = 'sb-mtemn430137@personal.example.com'
const PRICE_ADJUSTER = new BN('10').pow(new BN('10'))
const EVENT_ORACLE_REQUEST = web3.utils.keccak256(
  'OracleRequest(bytes32,address,bytes32,uint256,address,bytes4,uint256,uint256,bytes)',
)

// 1 LINK and 1 ETH both have 18 decimals
const oneETH = web3.utils.toWei(new BN(1), 'ether')
const oneLINK = oneETH


contract('Gateway', accounts => {
  const LinkToken = artifacts.require('LinkToken.sol')
  const Oracle = artifacts.require('Oracle.sol')
  const Gateway = artifacts.require('Gateway.sol')

  /***************************************************
   * Test Ethereum accounts
   */

  const defaultAccount = accounts[0]
  const nodeAddr = accounts[1] // chainlink node
  const makerAddr = accounts[2]
  const buyerAddr = accounts[3]
  const sellerAddr = accounts[4]


  /***************************************************
   * Test data
   */

  const jobIdStr1 = '4c7b7ffb66b344fbaa64995af81e355a'
  const jobIdStr2 = 'c9ff45d9c0724505a79d6c8df8611b79'
  const jobIdStr3 = '3dabbd2a14604aef8719fa8762542137'

  const jobIdHex1 = web3.utils.toHex(jobIdStr1)
  const jobIdHex2 = web3.utils.toHex(jobIdStr2)
  const jobIdHex3 = web3.utils.toHex(jobIdStr3)

  const paymentMethodName = 'WeChat'

  const makerPaymentDestination = 'maker@pay.me'
  const makerApiCredsIpfsHash = 'QmeYYwD4y4DgVVdAzhT7wW5vrvmbKPQj8wcV2pAzjbj886'

  // truffle contract handle
  let oracle, gate

  let linkAddr, oracleAddr, gateAddr

  let nativeEthAddress

  /***************************************************
   * Utility functions
   */

  /**
   * Add a new FiatPaymentMethod to Gateway contract
   * @return methodIdx Index into Gateway.fiatPaymentMethods
   * @return methodRec Gateway.FiatPaymentMethod record
   * @return tx addFiatPaymentMethod transaction
   */
  const addFiatPaymentMethod = async () => {
    const tx = await gate.addFiatPaymentMethod(
      paymentMethodName,
      oracleAddr,
      jobIdHex1,
      jobIdHex2,
      jobIdHex3,
      {
        from: defaultAccount,
      }
    )
    const methodIdx = tx.logs[0].args.methodIdx
    const methodRec = await gate.fiatPaymentMethods.call(methodIdx)
    return {methodIdx, methodRec, tx}
  }

  /**
   * New maker for a fiat/crypto pair and payment method
   * @return makerId Maker id into Gateway.makers
   * @return makerRec Gateway.Maker record
   * @return tx makerRegister transaction
   */
  const makerRegister = async (methodIdx) => {
    const tx = await gate.makerRegister(
      methodIdx,
      nativeEthAddress,
      "AUD",
      makerPaymentDestination,
      makerApiCredsIpfsHash,
      {
        from: makerAddr,
        // value: web3.utils.toWei(10, 'ether')
      }
    )
    const makerId = tx.logs[1].args.makerId
    const makerRec = await gate.makers.call(makerId)
    return {makerId, makerRec, tx}
  }

  // Transfer 1 LINK to Gateway contract
  const oneLinkToGateway = async (from) => {
    await link.transfer(gateAddr, oneLINK.toString(), {from})
  }


  /**
   * Setup contracts for testing.
   */
  beforeEach(async () => {
    web3.eth.defaultAccount = defaultAccount

    // truffle contract handles
    link = await LinkToken.new({from: defaultAccount})
    oracle = await Oracle.new(link.address, {from: defaultAccount})
    gate = await Gateway.new(link.address, {from: defaultAccount})

    linkAddr = link.address
    oracleAddr = oracle.address
    gateAddr = gate.address

    // Gives the chainlink node permission to fulfill requests in the Oracle
    await oracle.setFulfillmentPermission(nodeAddr, true, {
      from: defaultAccount,
    })

    // denotes trading native ETH (instead of a specific ERC20 token address)
    nativeEthAddress = await gate.ETH_ADDRESS.call()

    // give contract participants LINK for Oracle requests
    const linkAllocation = oneLINK.mul(new BN(100))
    await Promise.all(
      [makerAddr, buyerAddr, sellerAddr].map(acc =>
        link.transfer(acc, linkAllocation)
      )
    )
  })

  describe('#addFiatPaymentMethod', () => {
    it('adds new payment method', async () => {
      const {methodRec} = await addFiatPaymentMethod()

      assert.equal(methodRec.displayName, paymentMethodName, 'method name')
      assert.equal(methodRec.oracleAddr, oracleAddr, 'method oracleAddr')
      assert.equal(methodRec.newMakerJobId, jobIdHex1, 'method newMakerJobId')
      assert.equal(methodRec.buyCryptoOrderJobId, jobIdHex2, 'method buyCryptoOrderJobId')
      assert.equal(methodRec.buyCryptoOrderPayedJobId, jobIdHex3, 'method buyCryptoOrderPayedJobId')
    })
  })

  describe('#makerRegister', () => {
    beforeEach(async () => oneLinkToGateway(makerAddr))

    it('registers new maker', async () => {
      const {methodIdx} = await addFiatPaymentMethod()
      const {makerRec, tx} = await makerRegister(methodIdx)

      assert.equal(makerRec.makerAddr, makerAddr, 'makerAddr is the tx caller')
      assert.equal(makerRec.fiatPaymentMethodIdx.toString(), methodIdx.toString(), 'fiat payment method correct')
      assert.equal(makerRec.crypto, nativeEthAddress, 'crypto should be native eth')
      assert.equal(makerRec.fiat, "AUD", 'fiat is AUD')
      assert.isTrue(makerRec.active, 'maker active')

      request = h.decodeRunRequest(tx.receipt.rawLogs[2])
      assert.equal(oracleAddr, tx.receipt.rawLogs[2].address)
      assert.equal(request.topic, EVENT_ORACLE_REQUEST)
    })
  })

  describe('#makerBuyCryptoOrderCreate', () => {
    beforeEach(async () => Promise.all([
      oneLinkToGateway(makerAddr), // for makerRegister
      oneLinkToGateway(buyerAddr) // for buyCryptoOrderCreate
    ]))

    it('creates order', async () => {
      // setup method and maker for currency pair
      const {methodIdx} = await addFiatPaymentMethod()
      await makerRegister(methodIdx)

      // create an order
      const cryptoAmount = oneETH
      const tx = await gate.buyCryptoOrderCreate(
        nativeEthAddress,
        "AUD",
        cryptoAmount,
        methodIdx,
        {
          from: buyerAddr,
        }
      )

      const orderId = tx.logs[1].args.orderId
      const order = await gate.buyOrders.call(orderId)

      assert.equal(order.taker, buyerAddr, 'taker should by buyer')
      assert.equal(order.crypto, nativeEthAddress, 'crypto should be ETH')
      assert.equal(order.fiat, 'AUD', 'fiat should be AUD')
      assert.equal(order.amount.toString(), cryptoAmount.toString(), 'amount should be cryptoAmount')
      assert.equal(order.fiatPaymentMethodIdx.toString(), methodIdx, 'amount should be cryptoAmount')

      request = h.decodeRunRequest(tx.receipt.rawLogs[2])
      assert.equal(oracleAddr, tx.receipt.rawLogs[2].address)
      assert.equal(request.topic, EVENT_ORACLE_REQUEST)
    })
  })

  // describe('#placeOrder', () => {
  //   context('with LINK', () => {
  //     let request

  //     beforeEach(async () => {
  //       await link.transfer(gateAddr, oneLINK)
  //     })

  //     context('sending a request to a specific oracle contract address', () => {
  //       it('triggers a log event in the new Oracle contract', async () => {
  //         const tx = await gate.createRequestTo(
  //           oracleAddr,
  //           jobIdHex,
  //           payment,
  //           url,
  //           path,
  //           times,
  //           { from: seller },
  //         )
  //         request = h.decodeRunRequest(tx.receipt.rawLogs[3])
  //         assert.equal(oracleAddr, tx.receipt.rawLogs[3].address)
  //         assert.equal(
  //           request.topic,
  //           web3.utils.keccak256(
  //             'OracleRequest(bytes32,address,bytes32,uint256,address,bytes4,uint256,uint256,bytes)',
  //           ),
  //         )
  //       })
  //     })
  //   })
  // })

  // describe('#fulfill', () => {
  //   const expected = 50000
  //   const response = web3.utils.toHex(expected)
  //   let request

  //   beforeEach(async () => {
  //     await link.transfer(gateAddr, oneLINK)
  //     const tx = await gate.createRequestTo(
  //       oracleAddr,
  //       jobIdHex,
  //       payment,
  //       url,
  //       path,
  //       times,
  //       { from: seller },
  //     )
  //     request = h.decodeRunRequest(tx.receipt.rawLogs[3])
  //     await h.fulfillOracleRequest(oracle, request, response, { from: oracleAddr })
  //   })

  //   it('records the data given to it by the oracle', async () => {
  //     const currentPrice = await gate.data.call()
  //     assert.equal(
  //       web3.utils.toHex(currentPrice),
  //       web3.utils.padRight(expected, 64),
  //     )
  //   })

  //   context('when my contract does not recognize the request ID', () => {
  //     const otherId = web3.utils.toHex('otherId')

  //     beforeEach(async () => {
  //       request.id = otherId
  //     })

  //     it('does not accept the data provided', async () => {
  //       await expectRevert.unspecified(
  //         h.fulfillOracleRequest(oracle, request, response, {
  //           from: oracleAddr,
  //         }),
  //       )
  //     })
  //   })

  //   context('when called by anyone other than the oracle contract', () => {
  //     it('does not accept the data provided', async () => {
  //       await expectRevert.unspecified(
  //         gate.fulfill(request.id, response, { from: maker }),
  //       )
  //     })
  //   })
  // })

  describe('#withdrawLink', () => {
    beforeEach(async () => {
      await link.transfer(gateAddr, oneLINK)
    })

    context('when called by a non-owner', () => {
      it('cannot withdraw', async () => {
        await expectRevert.unspecified(gate.withdrawLink({from: makerAddr}))
      })
    })

    context('when called by the owner', () => {
      it('transfers LINK to the owner', async () => {
        const balanceBefore = await link.balanceOf(defaultAccount)
        await gate.withdrawLink({from: defaultAccount})
        assert.isTrue(await link.balanceOf(defaultAccount) > balanceBefore)
      })
    })
  })
})
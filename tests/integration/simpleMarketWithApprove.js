import test from "ava";
import api from "../../utils/lib/api";
import deployEnvironment from "../../utils/deploy/contracts";
import getAllBalances from "../../utils/lib/getAllBalances";
import getSignatureParameters from "../../utils/lib/getSignatureParameters";
import updatePriceFeed from "../../utils/lib/updatePriceFeed";
import { deployContract, retrieveContract } from "../../utils/lib/contracts";

const BigNumber = require("bignumber.js");
const environmentConfig = require("../../utils/config/environment.js");

const environment = "development";
const config = environmentConfig[environment];

BigNumber.config({ ERRORS: false });

// hoisted variables
let accounts;
let deployer;
let ethToken;
let fund;
let investor;
let manager;
let mlnToken;
let pricefeed;
let simpleMarketWithApprove;
let simpleAdapterWithApprove;
let trade1;
let version;
let deployed;

// mock data
const offeredValue = new BigNumber(10 ** 21);
const wantedShares = new BigNumber(10 ** 21);

test.before(async () => {
  deployed = await deployEnvironment(environment);
  accounts = await api.eth.accounts();
  [deployer, manager, investor, ,] = accounts;
  version = await deployed.Version;
  pricefeed = await deployed.PriceFeed;
  mlnToken = await deployed.MlnToken;
  ethToken = await deployed.EthToken;
  simpleMarketWithApprove = await deployContract(
    "exchange/thirdparty/SimpleMarketWithApprove",
    { from: deployer },
  );
  simpleAdapterWithApprove = await deployContract(
    "exchange/adapter/SimpleAdapterWithApprove",
    { from: deployer },
  );
  const [r, s, v] = await getSignatureParameters(manager);
  await version.instance.setupFund.postTransaction(
    { from: manager, gas: config.gas, gasPrice: config.gasPrice },
    [
      "Suisse Fund",
      deployed.MlnToken.address, // base asset
      config.protocol.fund.managementFee,
      config.protocol.fund.performanceFee,
      deployed.NoCompliance.address,
      deployed.RMMakeOrders.address,
      deployed.PriceFeed.address,
      [simpleMarketWithApprove.address],
      [simpleAdapterWithApprove.address],
      v,
      r,
      s,
    ],
  );
  const fundAddress = await version.instance.managerToFunds.call({}, [manager]);
  fund = await retrieveContract("Fund", fundAddress);

  // investment
  const initialTokenAmount = new BigNumber(10 ** 22);
  await mlnToken.instance.transfer.postTransaction(
    { from: deployer, gasPrice: config.gasPrice },
    [investor, initialTokenAmount, ""],
  );
  await mlnToken.instance.approve.postTransaction(
    { from: investor, gasPrice: config.gasPrice, gas: config.gas },
    [fund.address, offeredValue],
  );
  await fund.instance.requestInvestment.postTransaction(
    { from: investor, gas: config.gas, gasPrice: config.gasPrice },
    [offeredValue, wantedShares, false],
  );
  await updatePriceFeed(deployed);
  await updatePriceFeed(deployed);
  const requestId = await fund.instance.getLastRequestId.call({}, []);
  await fund.instance.executeRequest.postTransaction(
    { from: investor, gas: config.gas, gasPrice: config.gasPrice },
    [requestId],
  );
});

test.beforeEach(async () => {
  await updatePriceFeed(deployed);

  const [, referencePrice] = await pricefeed.instance.getReferencePrice.call(
    {},
    [mlnToken.address, ethToken.address],
  );
  const sellQuantity1 = new BigNumber(10 ** 19);
  trade1 = {
    sellQuantity: sellQuantity1,
    buyQuantity: referencePrice.dividedBy(10 ** 18).times(sellQuantity1),
  };
});

test.serial(
  "Manager makes an order through simple exchange adapter (with approve)",
  async t => {
    const pre = await getAllBalances(deployed, accounts, fund);
    await updatePriceFeed(deployed);
    await fund.instance.makeOrder.postTransaction(
      { from: manager, gas: config.gas, gasPrice: config.gasPrice },
      [
        0,
        mlnToken.address,
        ethToken.address,
        trade1.sellQuantity,
        trade1.buyQuantity,
      ],
    );
    const post = await getAllBalances(deployed, accounts, fund);
    const fundsApproved = await mlnToken.instance.allowance.call({}, [
      fund.address,
      simpleMarketWithApprove.address,
    ]);
    const heldinExchange = await fund.instance.quantityHeldInCustodyOfExchange.call(
      {},
      [mlnToken.address],
    );
    t.is(Number(heldinExchange), 0);
    t.deepEqual(fundsApproved, trade1.sellQuantity);
    t.deepEqual(post.investor.MlnToken, pre.investor.MlnToken);
    t.deepEqual(post.investor.EthToken, pre.investor.EthToken);
    t.deepEqual(post.investor.ether, pre.investor.ether);
    t.deepEqual(post.manager.EthToken, pre.manager.EthToken);
    t.deepEqual(post.manager.MlnToken, pre.manager.MlnToken);
    t.deepEqual(post.fund.MlnToken, pre.fund.MlnToken);
    t.deepEqual(post.fund.EthToken, pre.fund.EthToken);
    t.deepEqual(post.fund.ether, pre.fund.ether);
  },
);

test.serial("Third party takes the order", async t => {
  const pre = await getAllBalances(deployed, accounts, fund);
  const orderId = await simpleMarketWithApprove.instance.last_offer_id.call(
    {},
    [],
  );
  const exchangePreEthToken = Number(
    await ethToken.instance.balanceOf.call({}, [
      simpleMarketWithApprove.address,
    ]),
  );
  await ethToken.instance.approve.postTransaction(
    { from: deployer, gasPrice: config.gasPrice },
    [simpleMarketWithApprove.address, trade1.buyQuantity],
  );
  await simpleMarketWithApprove.instance.buy.postTransaction(
    { from: deployer, gas: config.gas, gasPrice: config.gasPrice },
    [orderId, trade1.sellQuantity],
  );

  const exchangePostMln = Number(
    await mlnToken.instance.balanceOf.call({}, [
      simpleMarketWithApprove.address,
    ]),
  );
  const exchangePostEthToken = Number(
    await ethToken.instance.balanceOf.call({}, [
      simpleMarketWithApprove.address,
    ]),
  );
  const post = await getAllBalances(deployed, accounts, fund);

  t.deepEqual(exchangePostMln, 0);
  t.deepEqual(exchangePostEthToken, exchangePreEthToken);
  t.deepEqual(
    post.deployer.MlnToken,
    pre.deployer.MlnToken.add(trade1.sellQuantity),
  );
  t.deepEqual(
    post.deployer.EthToken,
    pre.deployer.EthToken.minus(trade1.buyQuantity),
  );
  t.deepEqual(post.fund.MlnToken, pre.fund.MlnToken.minus(trade1.sellQuantity));
  t.deepEqual(post.fund.EthToken, pre.fund.EthToken.add(trade1.buyQuantity));
  t.deepEqual(post.investor.MlnToken, pre.investor.MlnToken);
  t.deepEqual(post.investor.EthToken, pre.investor.EthToken);
  t.deepEqual(post.investor.ether, pre.investor.ether);
  t.deepEqual(post.manager.EthToken, pre.manager.EthToken);
  t.deepEqual(post.manager.MlnToken, pre.manager.MlnToken);
  t.deepEqual(post.manager.ether, pre.manager.ether);
  t.deepEqual(post.fund.ether, pre.fund.ether);
});

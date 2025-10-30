require("dotenv").config();
const { ethers } = require("ethers");

(async () => {
  const {
    RPC_URL,
    SEPOLIA_RPC_URL,
    CONTRACT_ADDRESS,
    OPERATOR_PRIVATE_KEY,
    PAYER_PRIVATE_KEY,
    RECIPIENT,
    REFUND_DESTINATION,
    WRAPPED_NATIVE_ADDRESS,
    USDC_ADDRESS,
    UNISWAP_V3_FACTORY,
    UNISWAP_V3_QUOTER,
    POOL_FEE_TIER,
    RECIPIENT_AMOUNT_WEI,
    FEE_AMOUNT_WEI,
    GAS_CUSHION_WEI
  } = process.env;

  const provider = new ethers.JsonRpcProvider(RPC_URL || SEPOLIA_RPC_URL);
  const operator = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
  const payer = new ethers.Wallet(PAYER_PRIVATE_KEY, provider);

  const transfersAddr = ethers.getAddress(CONTRACT_ADDRESS);
  const recipient = ethers.getAddress(RECIPIENT);
  const refundDest = ethers.getAddress(REFUND_DESTINATION);
  const weth = ethers.getAddress(WRAPPED_NATIVE_ADDRESS);
  const usdc = ethers.getAddress(USDC_ADDRESS);
  const uniFactory = ethers.getAddress(UNISWAP_V3_FACTORY);
  const quoter = ethers.getAddress(UNISWAP_V3_QUOTER);

  const feeTier = Number(POOL_FEE_TIER || 3000);
  const wantRecipient0 = BigInt(RECIPIENT_AMOUNT_WEI ?? ethers.parseUnits("5", 6));
  const wantFee0 = BigInt(FEE_AMOUNT_WEI ?? 0);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const transfersAbi = [
    "function swapAndTransferUniswapV3Native((uint256,uint256,address,address,address,uint256,bytes16,address,bytes,bytes),uint24) external payable"
  ];
  const factoryAbi = ["function getPool(address,address,uint24) view returns (address)"];
  const quoterV1Abi = ["function quoteExactOutputSingle(address,address,uint256,uint24,uint160) view returns (uint256)"];
  const quoterV2Abi = ["function quoteExactOutputSingle((address tokenIn,address tokenOut,uint24 fee,uint256 amountOut,uint160 sqrtPriceLimitX96)) view returns (uint256)"];

  const factory = new ethers.Contract(uniFactory, factoryAbi, provider);
  const [a, b] = (ethers.getBigInt(weth) < ethers.getBigInt(usdc)) ? [weth, usdc] : [usdc, weth];
  const pool = await factory.getPool(a, b, feeTier);
  if (pool === ethers.ZeroAddress) throw new Error(`No pool at fee ${feeTier}`);

  const balance = await provider.getBalance(await payer.getAddress());
  const cushion = BigInt(GAS_CUSHION_WEI ?? ethers.parseEther("0.001"));
  let budget = balance / 2n;
  if (budget <= cushion) throw new Error("Low balance");
  budget -= cushion;

  const q1 = new ethers.Contract(quoter, quoterV1Abi, provider);
  const q2 = new ethers.Contract(quoter, quoterV2Abi, provider);
  async function quoteETHForUSDC(outUSDC) {
    try {
      return await q2.quoteExactOutputSingle.staticCall({ tokenIn: weth, tokenOut: usdc, fee: feeTier, amountOut: outUSDC, sqrtPriceLimitX96: 0 });
    } catch {
      return await q1.quoteExactOutputSingle.staticCall(weth, usdc, outUSDC, feeTier, 0);
    }
  }

  let wantRecipient = wantRecipient0;
  let wantFee = wantFee0;
  let totalUSDC = wantRecipient + wantFee;

  let neededETH = await quoteETHForUSDC(totalUSDC);
  if (neededETH > budget) {
    const scale = Number(budget) / Number(neededETH);
    const scaledTotal = BigInt(Math.max(0, Math.floor(Number(totalUSDC) * scale)));
    if (scaledTotal === 0n) throw new Error("Budget too low");
    const ratio = wantRecipient0 === 0n ? 0 : Number(wantFee0) / Number(wantRecipient0);
    wantRecipient = BigInt(Math.floor(Number(scaledTotal) / (1 + ratio)));
    wantFee = scaledTotal - wantRecipient;
    totalUSDC = wantRecipient + wantFee;
    neededETH = await quoteETHForUSDC(totalUSDC);
    if (neededETH > budget) throw new Error("Re-quote exceeds budget");
  }

  const operatorAddr = await operator.getAddress();
  const senderAddr = await payer.getAddress();
  const chainId = BigInt((await provider.getNetwork()).chainId);
  const idBytes16 = ethers.hexlify(ethers.randomBytes(16));

  const packed = ethers.solidityPackedKeccak256(
    ["uint256","uint256","address","address","address","uint256","bytes16","address","uint256","address","address"],
    [totalUSDC, deadline, recipient, usdc, refundDest, wantFee, idBytes16, operatorAddr, chainId, senderAddr, transfersAddr]
  );
  const signature = await operator.signMessage(ethers.getBytes(packed));

  const intent = [
    wantRecipient,
    deadline,
    recipient,
    usdc,
    refundDest,
    wantFee,
    idBytes16,
    operatorAddr,
    signature,
    "0x"
  ];

  const transfers = new ethers.Contract(transfersAddr, transfersAbi, payer);
  const gas = await transfers.swapAndTransferUniswapV3Native.estimateGas(intent, feeTier, { value: neededETH });
  const tx = await transfers.swapAndTransferUniswapV3Native(intent, feeTier, { value: neededETH, gasLimit: gas * 12n / 10n });
  const rcpt = await tx.wait();

  console.log(JSON.stringify({
    txHash: rcpt.hash,
    spentETH: neededETH.toString(),
    halfBalance: (balance / 2n).toString(),
    gasCushion: cushion.toString(),
    recipientUSDC: wantRecipient.toString(),
    feeUSDC: wantFee.toString(),
    poolFeeTier: feeTier
  }));
})();

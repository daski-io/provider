import {
  concatHex,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  type Hex,
} from "viem";

const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;

export function standardSplitterFixture() {
  const token = "0x6666666666666666666666666666666666666666" as const;
  const providerPayee = "0x8888888888888888888888888888888888888888" as const;
  const daskiCommissionReceiver = "0x9999999999999999999999999999999999999999" as const;
  const splitterFactory = "0x1212121212121212121212121212121212121212" as const;
  const splitterCreationCode = "0x6000" as const;
  const splitterCreationCodeHash = keccak256(splitterCreationCode);
  const splitterDeploymentSalt = hash("f");
  const constructorArgs = encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "uint16" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
    ],
    [84532n, token, providerPayee, daskiCommissionReceiver, 500, hash("8"), hash("7"), hash("6"), 1n],
  );
  const splitterInitCodeHash = keccak256(concatHex([splitterCreationCode, constructorArgs]));
  return {
    token,
    splitter: getCreate2Address({
      from: splitterFactory,
      salt: splitterDeploymentSalt,
      bytecodeHash: splitterInitCodeHash,
    }),
    splitterFactory,
    splitterFactoryRuntimeCodeHash: hash("3"),
    splitterCreationCode,
    splitterCreationCodeHash,
    splitterInitCodeHash,
    splitterDeploymentSalt,
    splitterRuntimeCodeHash: hash("4"),
    splitterDeploymentTransaction: hash("1"),
    splitterDeploymentBlockNumber: "123",
    splitterDeploymentBlockHash: hash("b"),
    splitterActivationBlockNumber: "123",
    splitterActivationBlockHash: hash("a"),
    splitterActivationPosition: "END_OF_BLOCK" as const,
    splitterStartingTokenBalance: "0",
    splitterStartingReleaseSequence: "0",
    providerPayee,
    daskiCommissionReceiver,
  };
}

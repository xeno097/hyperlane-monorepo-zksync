import { ethers, utils } from 'ethers';
import { Hex, decodeFunctionData, parseAbi } from 'viem';

import {
  ProxyAdmin__factory,
  TransparentUpgradeableProxy__factory,
  ZKSyncArtifact,
} from '@hyperlane-xyz/core';
import { Address, assert, eqAddress, sleep } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../../types.js';
import { proxyAdmin, proxyImplementation } from '../proxy.js';

import { ContractVerificationInput } from './types.js';

const { Interface } = await import('@ethersproject/abi');

export function formatFunctionArguments(
  fragment: utils.Fragment,
  args: any[],
): any {
  const params = Object.fromEntries(
    fragment.inputs.map((input, index) => [input.name, args[index]]),
  );
  return JSON.stringify(params, null, 2);
}

export function getConstructorArguments(
  contract: ethers.Contract,
  bytecode: string,
): any {
  const tx = contract.deployTransaction;
  if (tx === undefined) throw new Error('deploy transaction not found');
  return tx.data.replace(bytecode, '');
}

export function buildVerificationInput(
  name: string,
  address: string,
  constructorArguments: string,
  isProxy: boolean = name.endsWith('Proxy'),
  expectedimplementation?: string,
): ContractVerificationInput {
  return {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    address,
    constructorArguments,
    isProxy,
    expectedimplementation,
  };
}

export function getContractVerificationInput({
  name,
  contract,
  bytecode,
  isProxy,
  expectedimplementation,
}: {
  name: string;
  contract: ethers.Contract;
  bytecode: string;
  isProxy?: boolean;
  expectedimplementation?: Address;
}): ContractVerificationInput {
  const args = getConstructorArguments(contract, bytecode);
  return buildVerificationInput(
    name,
    contract.address,
    args,
    isProxy,
    expectedimplementation,
  );
}

export async function getContractVerificationInputForZKSync({
  name,
  contract,
  constructorArgs,
  artifact,
  isProxy,
  expectedimplementation,
}: {
  name: string;
  contract: ethers.Contract;
  constructorArgs: any[];
  artifact: ZKSyncArtifact;
  isProxy?: boolean;
  expectedimplementation?: Address;
}): Promise<ContractVerificationInput> {
  const args = encodeArguments(artifact.abi, constructorArgs);
  return buildVerificationInput(
    name,
    contract.address,
    args,
    isProxy,
    expectedimplementation,
  );
}

export function encodeArguments(abi: any, constructorArgs: any[]): string {
  const contractInterface = new Interface(abi);
  let deployArgumentsEncoded;
  try {
    deployArgumentsEncoded = contractInterface
      .encodeDeploy(constructorArgs)
      .replace('0x', '');
  } catch (error: any) {
    throw new Error('Cant encode constructor args');
  }

  return deployArgumentsEncoded;
}

/**
 * Check if the artifact should be added to the verification inputs.
 * @param verificationInputs - The verification inputs for the chain.
 * @param chain - The chain to check.
 * @param artifact - The artifact to check.
 * @returns
 */
export function shouldAddVerificationInput(
  verificationInputs: ChainMap<ContractVerificationInput[]>,
  chain: ChainName,
  artifact: ContractVerificationInput,
): boolean {
  return !verificationInputs[chain].some(
    (existingArtifact) =>
      existingArtifact.name === artifact.name &&
      eqAddress(existingArtifact.address, artifact.address) &&
      existingArtifact.constructorArguments === artifact.constructorArguments &&
      existingArtifact.isProxy === artifact.isProxy,
  );
}

/**
 * @notice Defines verification delay times for different blockchain explorer families.
 * @dev This constant object associates explorer families with specific delay times (in milliseconds)
 */
export const FamilyVerificationDelay = {
  [ExplorerFamily.Etherscan]: 40000,
} as const;

/*
 * Retrieves the constructor args using their respective Explorer and/or RPC (eth_getTransactionByHash)
 */
export async function getConstructorArgumentsApi({
  chainName,
  contractAddress,
  bytecode,
  multiProvider,
}: {
  bytecode: string;
  chainName: string;
  contractAddress: string;
  multiProvider: MultiProvider;
}): Promise<string> {
  const { family } = multiProvider.getExplorerApi(chainName);

  let constructorArgs: string;
  switch (family) {
    case ExplorerFamily.Routescan:
    case ExplorerFamily.Etherscan:
      constructorArgs = await getEtherscanConstructorArgs({
        chainName,
        contractAddress,
        bytecode,
        multiProvider,
      });
      break;
    case ExplorerFamily.Blockscout:
      constructorArgs = await getBlockScoutConstructorArgs({
        chainName,
        contractAddress,
        multiProvider,
      });
      break;
    case ExplorerFamily.ZKSync:
      constructorArgs = await getZkSyncConstructorArgs({
        chainName,
        contractAddress,
        bytecode,
        multiProvider,
      });
      break;
    default:
      throw new Error(`Explorer Family ${family} unsupported`);
  }

  return constructorArgs;
}

export async function getEtherscanConstructorArgs({
  bytecode,
  chainName,
  contractAddress,
  multiProvider,
}: {
  bytecode: string;
  chainName: string;
  contractAddress: Address;
  multiProvider: MultiProvider;
}): Promise<string> {
  const { apiUrl: blockExplorerApiUrl, apiKey: blockExplorerApiKey } =
    multiProvider.getExplorerApi(chainName);

  const url = new URL(blockExplorerApiUrl);
  url.searchParams.append('module', 'contract');
  url.searchParams.append('action', 'getcontractcreation');
  url.searchParams.append('contractaddresses', contractAddress);

  if (blockExplorerApiKey)
    url.searchParams.append('apikey', blockExplorerApiKey);

  await sleep(6000);

  const explorerResp = await fetch(url);
  const creationTx = (await explorerResp.json()).result[0].txHash;
  console.log(url.toString());
  console.log(creationTx);

  // Fetch deployment bytecode (includes constructor args)
  assert(creationTx, 'Contract creation transaction not found!');
  const metadata = multiProvider.getChainMetadata(chainName);
  const rpcUrl = metadata.rpcUrls[0].http;

  const creationTxResp = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      method: 'eth_getTransactionByHash',
      params: [creationTx],
      id: 1,
      jsonrpc: '2.0',
    }),
  });

  // https://zero-network.calderaexplorer.xyz/verification/contract_verification/api?module=contract&action=getcontractcreation&contractaddresses=0x3f7F02453518A55C0c6F89F0A6A8ab6c22Da01Df

  // Truncate the deployment bytecode
  const creationInput: string = (await creationTxResp.json()).result.input;
  return creationInput.substring(bytecode.length);
}

export async function getZkSyncConstructorArgs({
  chainName,
  contractAddress,
  multiProvider,
}: {
  bytecode: string;
  chainName: string;
  contractAddress: Address;
  multiProvider: MultiProvider;
}): Promise<string> {
  const { apiUrl: blockExplorerApiUrl, apiKey: blockExplorerApiKey } =
    multiProvider.getExplorerApi(chainName);

  const url = new URL(
    blockExplorerApiUrl.replace('verification/contract_verification', 'api'),
  );
  url.searchParams.append('module', 'contract');
  url.searchParams.append('action', 'getcontractcreation');
  url.searchParams.append('contractaddresses', contractAddress);

  if (blockExplorerApiKey)
    url.searchParams.append('apikey', blockExplorerApiKey);

  await sleep(6000);

  const explorerResp = await fetch(url);
  const creationTx = (await explorerResp.json()).result[0].txHash;
  console.log(url.toString());
  console.log(creationTx);

  // Fetch deployment bytecode (includes constructor args)
  assert(creationTx, 'Contract creation transaction not found!');
  const metadata = multiProvider.getChainMetadata(chainName);
  const rpcUrl = metadata.rpcUrls[0].http;

  const creationTxResp = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      method: 'eth_getTransactionByHash',
      params: [creationTx],
      id: 1,
      jsonrpc: '2.0',
    }),
  });

  // https://zero-network.calderaexplorer.xyz/verification/contract_verification/api?module=contract&action=getcontractcreation&contractaddresses=0x3f7F02453518A55C0c6F89F0A6A8ab6c22Da01Df

  const tx = await creationTxResp.json();

  // Truncate the deployment bytecode
  const creationInput: string = tx.result.input;

  const res = decodeFunctionData({
    abi: parseAbi(['function create(bytes32,bytes32,bytes)']),
    data: creationInput as Hex,
  });

  console.log(res.args[2]);

  return res.args[2].replace('0x', '');
}

export async function getBlockScoutConstructorArgs({
  chainName,
  contractAddress,
  multiProvider,
}: {
  chainName: string;
  contractAddress: Address;
  multiProvider: MultiProvider;
}): Promise<string> {
  const { apiUrl: blockExplorerApiUrl } =
    multiProvider.getExplorerApi(chainName);
  const url = new URL(
    `/api/v2/smart-contracts/${contractAddress}`,
    blockExplorerApiUrl,
  );

  const smartContractResp = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  return (await smartContractResp.json()).constructor_args;
}

export async function getProxyAndAdminInput({
  chainName,
  multiProvider,
  proxyAddress,
}: {
  chainName: string;
  multiProvider: MultiProvider;
  proxyAddress: Address;
}): Promise<{
  proxyAdminInput: ContractVerificationInput;
  transparentUpgradeableProxyInput: ContractVerificationInput;
}> {
  const provider = multiProvider.getProvider(chainName);

  const proxyAdminAddress = await proxyAdmin(provider, proxyAddress);
  const proxyAdminConstructorArgs = await getConstructorArgumentsApi({
    chainName,
    multiProvider,
    bytecode: ProxyAdmin__factory.bytecode,
    contractAddress: proxyAdminAddress,
  });
  const proxyAdminInput = buildVerificationInput(
    'ProxyAdmin',
    proxyAdminAddress,
    proxyAdminConstructorArgs,
  );

  const proxyConstructorArgs = await getConstructorArgumentsApi({
    chainName,
    multiProvider,
    contractAddress: proxyAddress,
    bytecode: TransparentUpgradeableProxy__factory.bytecode,
  });
  const transparentUpgradeableProxyInput = buildVerificationInput(
    'TransparentUpgradeableProxy',
    proxyAddress,
    proxyConstructorArgs,
    true,
    await proxyImplementation(provider, proxyAddress),
  );

  return { proxyAdminInput, transparentUpgradeableProxyInput };
}

export async function getImplementationInput({
  bytecode,
  chainName,
  contractName,
  implementationAddress,
  multiProvider,
}: {
  bytecode: string;
  chainName: string;
  contractName: string;
  implementationAddress: Address;
  multiProvider: MultiProvider;
}): Promise<ContractVerificationInput> {
  const implementationConstructorArgs = await getConstructorArgumentsApi({
    bytecode,
    chainName,
    multiProvider,
    contractAddress: implementationAddress,
  });
  return buildVerificationInput(
    contractName,
    implementationAddress,
    implementationConstructorArgs,
  );
}

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  BridgeAdapterConfig,
  ChainMap,
  ChainName,
  CoreConfig,
  IgpConfig,
  MultiProtocolProvider,
  MultiProvider,
  OwnableConfig,
  RouterConfig,
} from '@hyperlane-xyz/sdk';
import { mustGet, objKeys, objMap, objMerge } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { environments } from '../../config/environments/index.js';
import { getHyperlaneCore } from '../../scripts/core-utils.js';
import { CloudAgentKey } from '../agents/keys.js';
import { Role } from '../roles.js';

import { RootAgentConfig } from './agent/agent.js';
import { CheckWarpDeployConfig, KeyFunderConfig } from './funding.js';
import { HelloWorldConfig } from './helloworld/types.js';
import { InfrastructureConfig } from './infrastructure.js';
import { LiquidityLayerRelayerConfig } from './middleware.js';

export type DeployEnvironment = keyof typeof environments;
export type EnvironmentChain<E extends DeployEnvironment> = Extract<
  keyof (typeof environments)[E],
  ChainName
>;
export enum AgentEnvironment {
  Testnet = 'testnet',
  Mainnet = 'mainnet',
}
export const envNameToAgentEnv: Record<DeployEnvironment, AgentEnvironment> = {
  test: AgentEnvironment.Testnet,
  testnet4: AgentEnvironment.Testnet,
  mainnet3: AgentEnvironment.Mainnet,
};

export type EnvironmentConfig = {
  environment: DeployEnvironment;
  supportedChainNames: ChainName[];
  // Get the registry with or without environment-specific secrets.
  getRegistry: (useSecrets?: boolean) => Promise<IRegistry>;
  // Each AgentConfig, keyed by the context
  agents: Partial<Record<Contexts, RootAgentConfig>>;
  core: ChainMap<CoreConfig>;
  igp: ChainMap<IgpConfig>;
  owners: ChainMap<OwnableConfig>;
  infra: InfrastructureConfig;
  getMultiProtocolProvider: () => Promise<MultiProtocolProvider>;
  getMultiProvider: (
    context?: Contexts,
    role?: Role,
    useSecrets?: boolean,
    chains?: ChainName[],
  ) => Promise<MultiProvider>;
  getKeys: (
    context?: Contexts,
    role?: Role,
  ) => Promise<ChainMap<CloudAgentKey>>;
  helloWorld?: Partial<Record<Contexts, HelloWorldConfig>>;
  keyFunderConfig?: KeyFunderConfig<string[]>;
  checkWarpDeployConfig?: CheckWarpDeployConfig;
  liquidityLayerConfig?: {
    bridgeAdapters: ChainMap<BridgeAdapterConfig>;
    relayer: LiquidityLayerRelayerConfig;
  };
};

export function assertEnvironment(env: string): DeployEnvironment {
  const envNames = objKeys(environments);
  if (envNames.includes(env as any)) {
    return env as DeployEnvironment;
  }
  throw new Error(`Invalid environment ${env}, must be one of ${envNames}`);
}

// Gets the router configs for all chains in the environment.
// Relying solely on HyperlaneCore.getRouterConfig will result
// in missing any non-EVM chains -- here we merge the two.
export async function getRouterConfigsForAllVms(
  envConfig: EnvironmentConfig,
  multiProvider: MultiProvider,
): Promise<ChainMap<RouterConfig>> {
  const { core, chainAddresses } = await getHyperlaneCore(
    envConfig.environment,
    multiProvider,
  );
  const evmRouterConfig = core.getRouterConfig(envConfig.owners);

  const allRouterConfigs: ChainMap<RouterConfig> = objMap(
    chainAddresses,
    (chain, addresses) => {
      return {
        mailbox: mustGet(addresses, 'mailbox'),
        owner: mustGet(envConfig.owners, chain).owner,
      };
    },
  );

  // Merge, giving evmRouterConfig precedence
  return objMerge(allRouterConfigs, evmRouterConfig);
}

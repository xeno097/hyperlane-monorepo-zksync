use eyre::eyre;
use url::Url;

use h_eth::TransactionOverrides;

use hyperlane_core::config::{ConfigErrResultExt, OperationBatchConfig};
use hyperlane_core::{config::ConfigParsingError, HyperlaneDomainProtocol, NativeToken};

use crate::settings::envs::*;
use crate::settings::ChainConnectionConf;

use super::{parse_base_and_override_urls, parse_cosmos_gas_price, ValueParser};

#[allow(clippy::question_mark)] // TODO: `rustc` 1.80.1 clippy issue
pub fn build_ethereum_connection_conf(
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    default_rpc_consensus_type: &str,
    operation_batch: OperationBatchConfig,
) -> Option<ChainConnectionConf> {
    let Some(first_url) = rpcs.to_owned().clone().into_iter().next() else {
        return None;
    };
    let rpc_consensus_type = chain
        .chain(err)
        .get_opt_key("rpcConsensusType")
        .parse_string()
        .unwrap_or(default_rpc_consensus_type);

    let rpc_connection_conf = match rpc_consensus_type {
        "single" => Some(h_eth::RpcConnectionConf::Http { url: first_url }),
        "fallback" => Some(h_eth::RpcConnectionConf::HttpFallback {
            urls: rpcs.to_owned().clone(),
        }),
        "quorum" => Some(h_eth::RpcConnectionConf::HttpQuorum {
            urls: rpcs.to_owned().clone(),
        }),
        ty => Err(eyre!("unknown rpc consensus type `{ty}`"))
            .take_err(err, || &chain.cwp + "rpc_consensus_type"),
    };

    let transaction_overrides = chain
        .get_opt_key("transactionOverrides")
        .take_err(err, || &chain.cwp + "transaction_overrides")
        .flatten()
        .map(|value_parser| TransactionOverrides {
            gas_price: value_parser
                .chain(err)
                .get_opt_key("gasPrice")
                .parse_u256()
                .end(),
            gas_limit: value_parser
                .chain(err)
                .get_opt_key("gasLimit")
                .parse_u256()
                .end(),
            max_fee_per_gas: value_parser
                .chain(err)
                .get_opt_key("maxFeePerGas")
                .parse_u256()
                .end(),
            max_priority_fee_per_gas: value_parser
                .chain(err)
                .get_opt_key("maxPriorityFeePerGas")
                .parse_u256()
                .end(),
        })
        .unwrap_or_default();

    Some(ChainConnectionConf::Ethereum(h_eth::ConnectionConf {
        rpc_connection: rpc_connection_conf?,
        transaction_overrides,
        operation_batch,
    }))
}

pub fn build_cosmos_connection_conf(
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    operation_batch: OperationBatchConfig,
) -> Option<ChainConnectionConf> {
    let mut local_err = ConfigParsingError::default();
    let grpcs =
        parse_base_and_override_urls(chain, "grpcUrls", "customGrpcUrls", "http", &mut local_err);

    let chain_id = chain
        .chain(&mut local_err)
        .get_key("chainId")
        .parse_string()
        .end()
        .or_else(|| {
            local_err.push(&chain.cwp + "chain_id", eyre!("Missing chain id for chain"));
            None
        });

    let prefix = chain
        .chain(err)
        .get_key("bech32Prefix")
        .parse_string()
        .end()
        .or_else(|| {
            local_err.push(
                &chain.cwp + "bech32Prefix",
                eyre!("Missing bech32 prefix for chain"),
            );
            None
        });

    let canonical_asset = if let Some(asset) = chain
        .chain(err)
        .get_opt_key("canonicalAsset")
        .parse_string()
        .end()
    {
        Some(asset.to_string())
    } else if let Some(hrp) = prefix {
        Some(format!("u{}", hrp))
    } else {
        local_err.push(
            &chain.cwp + "canonical_asset",
            eyre!("Missing canonical asset for chain"),
        );
        None
    };

    let gas_price = chain
        .chain(err)
        .get_opt_key("gasPrice")
        .and_then(parse_cosmos_gas_price)
        .end();

    let contract_address_bytes = chain
        .chain(err)
        .get_opt_key("contractAddressBytes")
        .parse_u64()
        .end();

    let native_token = parse_native_token(chain, err, 18);

    if !local_err.is_ok() {
        err.merge(local_err);
        None
    } else {
        Some(ChainConnectionConf::Cosmos(h_cosmos::ConnectionConf::new(
            grpcs,
            rpcs.to_owned(),
            chain_id.unwrap().to_string(),
            prefix.unwrap().to_string(),
            canonical_asset.unwrap(),
            gas_price.unwrap(),
            contract_address_bytes.unwrap().try_into().unwrap(),
            operation_batch,
            native_token,
        )))
    }
}

fn build_sealevel_connection_conf(
    url: &Url,
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    operation_batch: OperationBatchConfig,
) -> h_sealevel::ConnectionConf {
    let native_token = parse_native_token(chain, err, 9);
    h_sealevel::ConnectionConf {
        url: url.clone(),
        operation_batch,
        native_token,
    }
}

fn parse_native_token(
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    default_decimals: u32,
) -> NativeToken {
    let native_token_decimals = chain
        .chain(err)
        .get_opt_key("nativeToken")
        .get_opt_key("decimals")
        .parse_u32()
        .unwrap_or(default_decimals);

    let native_token_denom = chain
        .chain(err)
        .get_opt_key("nativeToken")
        .get_opt_key("denom")
        .parse_string()
        .unwrap_or("");

    NativeToken {
        decimals: native_token_decimals,
        denom: native_token_denom.to_owned(),
    }
}

pub fn build_connection_conf(
    domain_protocol: HyperlaneDomainProtocol,
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    default_rpc_consensus_type: &str,
    operation_batch: OperationBatchConfig,
) -> Option<ChainConnectionConf> {
    match domain_protocol {
        HyperlaneDomainProtocol::Ethereum => build_ethereum_connection_conf(
            rpcs,
            chain,
            err,
            default_rpc_consensus_type,
            operation_batch,
        ),
        HyperlaneDomainProtocol::Fuel => rpcs
            .iter()
            .next()
            .map(|url| ChainConnectionConf::Fuel(h_fuel::ConnectionConf { url: url.clone() })),
        HyperlaneDomainProtocol::Sealevel => rpcs.iter().next().map(|url| {
            ChainConnectionConf::Sealevel(build_sealevel_connection_conf(
                url,
                chain,
                err,
                operation_batch,
            ))
        }),
        HyperlaneDomainProtocol::Cosmos => {
            build_cosmos_connection_conf(rpcs, chain, err, operation_batch)
        }
    }
}

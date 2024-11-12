use std::collections::HashMap;

use derive_more::Deref;
use eyre::{eyre, Context, Result};
use sea_orm::{
    prelude::*, sea_query::OnConflict, ActiveValue::*, DeriveColumn, EnumIter, Insert, NotSet,
    QuerySelect,
};
use tracing::{debug, instrument, trace};

use hyperlane_core::{address_to_bytes, bytes_to_h512, h512_to_bytes, TxnInfo, H512};

use super::generated::transaction;

use crate::{conversions::u256_to_decimal, date_time, db::ScraperDb};

#[derive(Debug, Clone, Deref)]
pub struct StorableTxn {
    #[deref]
    pub info: TxnInfo,
    pub block_id: i64,
}

impl ScraperDb {
    pub async fn retrieve_block_id(&self, tx_id: i64) -> Result<Option<i64>> {
        #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
        enum QueryAs {
            BlockId,
        }
        let block_id = transaction::Entity::find()
            .filter(transaction::Column::Id.eq(tx_id))
            .select_only()
            .column_as(transaction::Column::BlockId, QueryAs::BlockId)
            .into_values::<i64, QueryAs>()
            .one(&self.0)
            .await?;
        Ok(block_id)
    }

    /// Lookup transactions and find their ids. Any transactions which are not
    /// found be excluded from the hashmap.
    pub async fn get_txn_ids(
        &self,
        hashes: impl Iterator<Item = &H512>,
    ) -> Result<HashMap<H512, i64>> {
        #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
        enum QueryAs {
            Id,
            Hash,
        }

        // check database to see which txns we already know and fetch their IDs
        let txns = transaction::Entity::find()
            .filter(transaction::Column::Hash.is_in(hashes.map(h512_to_bytes)))
            .select_only()
            .column_as(transaction::Column::Id, QueryAs::Id)
            .column_as(transaction::Column::Hash, QueryAs::Hash)
            .into_values::<(i64, Vec<u8>), QueryAs>()
            .all(&self.0)
            .await
            .context("When querying transactions")?
            .into_iter()
            .map(|(id, hash)| Ok((bytes_to_h512(&hash), id)))
            .collect::<Result<HashMap<_, _>>>()?;

        trace!(?txns, "Queried transaction info for hashes");
        Ok(txns)
    }

    /// Store a new transaction into the database (or update an existing one).
    #[instrument(skip_all)]
    pub async fn store_txns(&self, txns: impl Iterator<Item = StorableTxn>) -> Result<()> {
        let models = txns
            .map(|txn| {
                let receipt = txn
                    .receipt
                    .as_ref()
                    .ok_or_else(|| eyre!("Transaction is not yet included"))?;

                Ok(transaction::ActiveModel {
                    id: NotSet,
                    block_id: Unchanged(txn.block_id),
                    gas_limit: Set(u256_to_decimal(txn.gas_limit)),
                    max_priority_fee_per_gas: Set(txn
                        .max_priority_fee_per_gas
                        .map(u256_to_decimal)),
                    hash: Unchanged(h512_to_bytes(&txn.hash)),
                    time_created: Set(date_time::now()),
                    gas_used: Set(u256_to_decimal(receipt.gas_used)),
                    gas_price: Set(txn.gas_price.map(u256_to_decimal)),
                    effective_gas_price: Set(receipt.effective_gas_price.map(u256_to_decimal)),
                    nonce: Set(txn.nonce as i64),
                    sender: Set(address_to_bytes(&txn.sender)),
                    recipient: Set(txn.recipient.as_ref().map(address_to_bytes)),
                    max_fee_per_gas: Set(txn.max_fee_per_gas.map(u256_to_decimal)),
                    cumulative_gas_used: Set(u256_to_decimal(receipt.cumulative_gas_used)),
                    raw_input_data: Set(txn.raw_input_data.clone()),
                })
            })
            .collect::<Result<Vec<_>>>()?;

        debug_assert!(!models.is_empty());
        debug!(txns = models.len(), "Writing txns to database");
        trace!(?models, "Writing txns to database");

        match Insert::many(models)
            .on_conflict(
                OnConflict::column(transaction::Column::Hash)
                    .do_nothing()
                    .to_owned(),
            )
            .exec(&self.0)
            .await
        {
            Ok(_) => Ok(()),
            Err(DbErr::RecordNotInserted) => Ok(()),
            Err(e) => Err(e).context("When inserting transactions"),
        }
    }
}

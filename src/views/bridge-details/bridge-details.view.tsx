import { FC, useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { BigNumber } from "ethers";

import useBridgeDetailsStyles from "src/views/bridge-details/bridge-details.styles";
import Card from "src/views/shared/card/card.view";
import Header from "src/views/shared/header/header.view";
import { ReactComponent as NewWindowIcon } from "src/assets/icons/new-window.svg";
import { ReactComponent as SpinnerIcon } from "src/assets/icons/spinner.svg";
import Typography from "src/views/shared/typography/typography.view";
import Icon from "src/views/shared/icon/icon.view";
import Chain from "src/views/bridge-details/components/chain/chain";
import Error from "src/views/shared/error/error.view";
import { useBridgeContext } from "src/contexts/bridge.context";
import { useProvidersContext } from "src/contexts/providers.context";
import { useErrorContext } from "src/contexts/error.context";
import { useEnvContext } from "src/contexts/env.context";
import { usePriceOracleContext } from "src/contexts/price-oracle.context";
import { parseError } from "src/adapters/error";
import { getCurrency } from "src/adapters/storage";
import { AsyncTask, isMetamaskUserRejectedRequestError } from "src/utils/types";
import { getBridgeStatus, getChainName, getCurrencySymbol } from "src/utils/labels";
import { formatTokenAmount } from "src/utils/amounts";
import { calculateTransactionResponseFee } from "src/utils/fees";
import { roundFiat } from "src/utils/amounts";
import { Bridge } from "src/domain";
import routes from "src/routes";
import Button from "src/views/shared/button/button.view";
import { getChainTokens } from "src/constants";

interface HistoricalFees {
  step1?: string;
  step2?: string;
}

interface FiatHistoricalFees {
  step1?: number;
  step2?: number;
}

const calculateHistoricalFees = (bridge: Bridge): Promise<HistoricalFees> => {
  const feeToString = (fee: BigNumber | undefined) =>
    fee ? formatTokenAmount(fee, bridge.deposit.token) : undefined;

  const step1Promise = bridge.deposit.from.provider
    .getTransaction(bridge.deposit.txHash)
    .then(calculateTransactionResponseFee)
    .then(feeToString);

  const step2Promise =
    bridge.status === "completed"
      ? bridge.deposit.to.provider
          .getTransaction(bridge.claim.txHash)
          .then(calculateTransactionResponseFee)
          .then(feeToString)
      : Promise.resolve(undefined);

  return Promise.all([step1Promise, step2Promise]).then(([step1, step2]) => ({
    step1,
    step2,
  }));
};

const BridgeDetails: FC = () => {
  const { bridgeId } = useParams();
  const navigate = useNavigate();
  const env = useEnvContext();
  const { notifyError } = useErrorContext();
  const { getBridges, claim } = useBridgeContext();
  const { account, connectedProvider } = useProvidersContext();
  const { getTokenPrice } = usePriceOracleContext();
  const [incorrectNetworkMessage, setIncorrectNetworkMessage] = useState<string>();
  const [bridge, setBridge] = useState<AsyncTask<Bridge, string>>({
    status: "pending",
  });
  const [historicalFees, setHistoricalFees] = useState<HistoricalFees>({});
  const [fiatHistoricalFees, setFiatHistoricalFees] = useState<FiatHistoricalFees>({});
  const [fiatAmount, setFiatAmount] = useState<number>();
  const currencySymbol = getCurrencySymbol(getCurrency());

  const classes = useBridgeDetailsStyles({
    status: bridge.status === "successful" ? bridge.data.status : undefined,
  });

  const onClaim = () => {
    if (bridge.status === "successful" && bridge.data.status === "on-hold") {
      const { deposit, merkleProof } = bridge.data;
      claim({
        deposit,
        merkleProof,
      })
        .then(() => {
          navigate(routes.activity.path);
        })
        .catch((error) => {
          if (isMetamaskUserRejectedRequestError(error) === false) {
            void parseError(error).then((parsed) => {
              if (parsed === "wrong-network") {
                setIncorrectNetworkMessage(`Switch to ${getChainName(deposit.to)} to continue`);
              } else {
                notifyError(error);
              }
            });
          }
        });
    }
  };

  useEffect(() => {
    if (bridge.status === "successful") {
      if (bridge.data.deposit.to.chainId === connectedProvider?.chainId) {
        setIncorrectNetworkMessage(undefined);
      }
    }
  }, [connectedProvider, bridge]);

  useEffect(() => {
    if (env && account.status === "successful") {
      // ToDo: Get all the data only for the right bridge
      void getBridges({ env, ethereumAddress: account.data })
        .then((bridges) => {
          const foundBridge = bridges.find((bridge) => {
            return bridge.id === bridgeId;
          });
          if (foundBridge) {
            setBridge({
              status: "successful",
              data: foundBridge,
            });
          } else {
            setBridge({
              status: "failed",
              error: "Bridge not found",
            });
          }
        })
        .catch(notifyError);
    }
  }, [account, env, bridgeId, notifyError, getBridges]);

  useEffect(() => {
    if (bridge.status === "successful") {
      calculateHistoricalFees(bridge.data).then(setHistoricalFees).catch(notifyError);
    }
  }, [bridge, notifyError]);

  useEffect(() => {
    if (bridge.status === "successful") {
      const {
        deposit: { amount, from, token },
      } = bridge.data;

      // fiat amount
      getTokenPrice({ token, chain: from })
        .then((price) => {
          setFiatAmount(price * Number(formatTokenAmount(amount, token)));
        })
        .catch(() => setFiatAmount(undefined));

      // fiat historical fees
      const weth = getChainTokens(from).find((t) => t.symbol === "WETH");
      if (weth) {
        getTokenPrice({ token: weth, chain: from })
          .then((price) => {
            setFiatHistoricalFees({
              step1: historicalFees.step1 ? Number(historicalFees.step1) * price : undefined,
              step2: historicalFees.step2 ? Number(historicalFees.step2) * price : undefined,
            });
          })
          .catch(() => setFiatHistoricalFees({}));
      }
    }
  }, [bridge, historicalFees, getTokenPrice]);

  if (bridge.status === "pending" || bridge.status === "loading") {
    return <SpinnerIcon />;
  }

  if (bridge.status === "failed") {
    return <Navigate to={routes.activity.path} replace />;
  }

  const {
    status,
    deposit: { amount, from, to, token, txHash },
  } = bridge.data;

  const bridgeTxUrl = `${from.explorerUrl}/tx/${txHash}`;
  const claimTxUrl =
    bridge.data.status === "completed"
      ? `${to.explorerUrl}/tx/${bridge.data.claim.txHash}`
      : undefined;

  const { step1: step1Fee, step2: step2Fee } = historicalFees;
  const { step1: step1FiatFee, step2: step2FiatFee } = fiatHistoricalFees;

  if (env === undefined) {
    return null;
  }

  return (
    <>
      <Header title="Bridge Details" backTo="activity" />
      <Card className={classes.card}>
        <div className={classes.balance}>
          <Icon url={token.logoURI} className={classes.tokenIcon} size={48} />
          <Typography type="h1">{`${formatTokenAmount(amount, token)} ${token.symbol}`}</Typography>
          <Typography type="h2" className={classes.fiat}>{`${currencySymbol}${
            fiatAmount ? roundFiat(fiatAmount) : "--"
          }`}</Typography>
        </div>
        <div className={classes.row}>
          <Typography type="body2" className={classes.alignRow}>
            Status
          </Typography>
          <Typography type="body1" className={classes.alignRow}>
            <span className={classes.dot} />
            {getBridgeStatus(status)}
          </Typography>
        </div>
        <div className={classes.row}>
          <Typography type="body2" className={classes.alignRow}>
            From
          </Typography>
          <Chain chain={from} className={classes.alignRow} />
        </div>
        <div className={classes.row}>
          <Typography type="body2" className={classes.alignRow}>
            To
          </Typography>
          <Chain chain={to} className={classes.alignRow} />
        </div>
        {step1Fee && (
          <div className={classes.row}>
            <Typography type="body2" className={classes.alignRow}>
              Step 1 Fee ({getChainName(bridge.data.deposit.from)})
            </Typography>
            <Typography type="body1" className={classes.alignRow}>
              {`${step1Fee} ETH ~ ${currencySymbol}${
                step1FiatFee ? roundFiat(step1FiatFee) : "--"
              }`}
            </Typography>
          </div>
        )}
        {step2Fee && (
          <div className={classes.row}>
            <Typography type="body2" className={classes.alignRow}>
              Step 2 Fee ({getChainName(bridge.data.deposit.to)})
            </Typography>
            <Typography type="body1" className={classes.alignRow}>
              {`${step2Fee} ETH ~ ${currencySymbol}${
                step2FiatFee ? roundFiat(step2FiatFee) : "--"
              }`}
            </Typography>
          </div>
        )}
        <div className={classes.row}>
          <Typography type="body2" className={classes.alignRow}>
            Track step 1 transaction
          </Typography>
          <a href={bridgeTxUrl} target="_blank" className={classes.explorerButton} rel="noreferrer">
            <NewWindowIcon /> <Typography type="body1">View on explorer</Typography>
          </a>
        </div>
        {claimTxUrl && (
          <div className={`${classes.row} ${classes.lastRow}`}>
            <Typography type="body2" className={classes.alignRow}>
              Track step 2 transaction
            </Typography>
            <a
              href={claimTxUrl}
              target="_blank"
              className={classes.explorerButton}
              rel="noreferrer"
            >
              <NewWindowIcon /> <Typography type="body1">View on explorer</Typography>
            </a>
          </div>
        )}
      </Card>
      {(status === "initiated" || status === "on-hold") && (
        <div className={classes.finaliseRow}>
          <Button onClick={onClaim} disabled={status === "initiated"}>
            Finalise
            {status === "initiated" && <SpinnerIcon className={classes.finaliseSpinner} />}
          </Button>
          {incorrectNetworkMessage && <Error error={incorrectNetworkMessage} />}
        </div>
      )}
    </>
  );
};

export default BridgeDetails;

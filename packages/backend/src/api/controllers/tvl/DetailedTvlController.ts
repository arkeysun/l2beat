import { Logger } from '@l2beat/shared'
import {
  AssetId,
  ChainId,
  DetailedTvlApiResponse,
  Hash256,
  ProjectAssetsBreakdownApiResponse,
  ProjectId,
  ReportType,
  Token,
  TvlApiChart,
  TvlApiCharts,
} from '@l2beat/shared-pure'

import { ReportProject } from '../../../core/reports/ReportProject'
import { AggregatedReportRepository } from '../../../peripherals/database/AggregatedReportRepository'
import { AggregatedReportStatusRepository } from '../../../peripherals/database/AggregatedReportStatusRepository'
import { BalanceRepository } from '../../../peripherals/database/BalanceRepository'
import { PriceRepository } from '../../../peripherals/database/PriceRepository'
import { ReportRepository } from '../../../peripherals/database/ReportRepository'
import { getHourlyMinTimestamp } from '../utils/getHourlyMinTimestamp'
import { getSixHourlyMinTimestamp } from '../utils/getSixHourlyMinTimestamp'
import { getProjectAssetChartData } from './charts'
import {
  getCanonicalAssetsBreakdown,
  getNonCanonicalAssetsBreakdown,
  groupAndMergeBreakdowns,
  groupByProjectIdAndAssetType,
  groupByProjectIdAndTimestamp,
} from './detailedTvl'
import { generateDetailedTvlApiResponse } from './generateDetailedTvlApiResponse'
import {
  fillAllMissingAggregatedReports,
  fillAllMissingAssetReports,
} from './timerange'

interface DetailedTvlControllerOptions {
  errorOnUnsyncedDetailedTvl: boolean
}

type ProjectAssetBreakdownResult =
  | {
      result: 'success'
      data: ProjectAssetsBreakdownApiResponse
    }
  | {
      result: 'error'
      error: 'DATA_NOT_FULLY_SYNCED' | 'NO_DATA'
    }

type DetailedTvlResult =
  | {
      result: 'success'
      data: DetailedTvlApiResponse
    }
  | {
      result: 'error'
      error: 'DATA_NOT_FULLY_SYNCED' | 'NO_DATA'
    }

type DetailedAssetTvlResult =
  | {
      result: 'success'
      data: TvlApiCharts
    }
  | {
      result: 'error'
      error: 'INVALID_PROJECT_OR_ASSET' | 'NO_DATA' | 'DATA_NOT_FULLY_SYNCED'
    }

export class DetailedTvlController {
  constructor(
    private readonly aggregatedReportRepository: AggregatedReportRepository,
    private readonly reportRepository: ReportRepository,
    private readonly aggregatedReportStatusRepository: AggregatedReportStatusRepository,
    private readonly balanceRepository: BalanceRepository,
    private readonly priceRepository: PriceRepository,
    private readonly projects: ReportProject[],
    private readonly tokens: Token[],
    private readonly logger: Logger,
    private readonly aggregatedConfigHash: Hash256,
    private readonly options: DetailedTvlControllerOptions,
  ) {
    this.logger = this.logger.for(this)
  }

  /**
   * TODO: Add project exclusion?
   */
  async getDetailedTvlApiResponse(): Promise<DetailedTvlResult> {
    const dataTimings = await this.getDataTimings()

    const { latestTimestamp, isSynced } = dataTimings

    if (!latestTimestamp) {
      return {
        result: 'error',
        error: 'NO_DATA',
      }
    }

    if (!isSynced && this.options.errorOnUnsyncedDetailedTvl) {
      return {
        result: 'error',
        error: 'DATA_NOT_FULLY_SYNCED',
      }
    }

    const [hourlyReports, sixHourlyReports, dailyReports, latestReports] =
      await Promise.all([
        this.aggregatedReportRepository.getHourlyWithAnyType(
          getHourlyMinTimestamp(dataTimings.latestTimestamp),
        ),

        this.aggregatedReportRepository.getSixHourlyWithAnyType(
          getSixHourlyMinTimestamp(dataTimings.latestTimestamp),
        ),

        this.aggregatedReportRepository.getDailyWithAnyType(),

        this.reportRepository.getByTimestamp(latestTimestamp),
      ])

    const allProjectIdsToSeekFor = [
      ...this.projects.map((x) => x.projectId),
      ProjectId.ALL,
      ProjectId.BRIDGES,
      ProjectId.LAYER2S,
    ]

    const { filledHourlyReports, filledSixHourlyReports, filledDailyReports } =
      fillAllMissingAggregatedReports(
        allProjectIdsToSeekFor,
        {
          hourly: hourlyReports,
          sixHourly: sixHourlyReports,
          daily: dailyReports,
        },
        latestTimestamp,
      )

    /**
     * ProjectID => Timestamp => [Report, Report, Report, Report]
     * Ideally 4 reports per project per timestamp corresponding to 4 Value Types
     */
    const groupedHourlyReports =
      groupByProjectIdAndTimestamp(filledHourlyReports)

    const groupedSixHourlyReportsTree = groupByProjectIdAndTimestamp(
      filledSixHourlyReports,
    )

    const groupedDailyReports = groupByProjectIdAndTimestamp(filledDailyReports)

    /**
     * ProjectID => Asset => Report[]
     * Ideally 1 report. Some chains like Arbitrum may have multiple reports per asset differentiated by Value Type
     * That isl 1 report for USDC of value type CBV and 1 report for USDC of value type EBV
     * Reduce (dedupe) occurs later in the call chain
     * @see getProjectTokensCharts
     */
    const groupedLatestReports = groupByProjectIdAndAssetType(latestReports)

    const tvlApiResponse = generateDetailedTvlApiResponse(
      groupedHourlyReports,
      groupedSixHourlyReportsTree,
      groupedDailyReports,
      groupedLatestReports,
      this.projects.map((x) => x.projectId),
    )

    return {
      result: 'success',
      data: tvlApiResponse,
    }
  }

  async getDetailedAssetTvlApiResponse(
    projectId: ProjectId,
    chainId: ChainId,
    assetId: AssetId,
    assetType: ReportType,
  ): Promise<DetailedAssetTvlResult> {
    const asset = this.tokens.find((t) => t.id === assetId)
    const project = this.projects.find((p) => p.projectId === projectId)

    if (!asset || !project) {
      return {
        result: 'error',
        error: 'INVALID_PROJECT_OR_ASSET',
      }
    }

    const { latestTimestamp, isSynced } = await this.getDataTimings()

    if (!latestTimestamp) {
      return {
        result: 'error',
        error: 'NO_DATA',
      }
    }

    if (!isSynced && this.options.errorOnUnsyncedDetailedTvl) {
      return {
        result: 'error',
        error: 'DATA_NOT_FULLY_SYNCED',
      }
    }

    const [hourlyReports, sixHourlyReports, dailyReports] = await Promise.all([
      this.reportRepository.getHourlyForDetailed(
        projectId,
        chainId,
        assetId,
        assetType,
        getHourlyMinTimestamp(latestTimestamp),
      ),
      this.reportRepository.getSixHourlyForDetailed(
        projectId,
        chainId,
        assetId,
        assetType,
        getSixHourlyMinTimestamp(latestTimestamp),
      ),
      this.reportRepository.getDailyForDetailed(
        projectId,
        chainId,
        assetId,
        assetType,
      ),
    ])
    const assetSymbol = asset.symbol.toLowerCase()

    const types: TvlApiChart['types'] = ['timestamp', assetSymbol, 'usd']

    const { filledHourlyReports, filledSixHourlyReports, filledDailyReports } =
      fillAllMissingAssetReports(
        asset,
        project.projectId,
        {
          hourly: hourlyReports,
          sixHourly: sixHourlyReports,
          daily: dailyReports,
        },
        latestTimestamp,
      )

    return {
      result: 'success',
      data: {
        hourly: {
          types,
          data: getProjectAssetChartData(filledHourlyReports, asset.decimals),
        },
        sixHourly: {
          types,
          data: getProjectAssetChartData(
            filledSixHourlyReports,
            asset.decimals,
          ),
        },
        daily: {
          types,
          data: getProjectAssetChartData(filledDailyReports, asset.decimals),
        },
      },
    }
  }

  async getProjectTokenBreakdownApiResponse(): Promise<ProjectAssetBreakdownResult> {
    const { latestTimestamp, isSynced } = await this.getDataTimings()

    if (!latestTimestamp) {
      return {
        result: 'error',
        error: 'NO_DATA',
      }
    }

    if (!isSynced && this.options.errorOnUnsyncedDetailedTvl) {
      return {
        result: 'error',
        error: 'DATA_NOT_FULLY_SYNCED',
      }
    }

    const [latestReports, balances, prices] = await Promise.all([
      this.reportRepository.getByTimestamp(latestTimestamp),
      this.balanceRepository.getByTimestamp(latestTimestamp),
      this.priceRepository.getByTimestamp(latestTimestamp),
    ])

    const externalAssetsBreakdown = getNonCanonicalAssetsBreakdown(
      latestReports,
      this.tokens,
      'EBV',
    )

    const nativeAssetsBreakdown = getNonCanonicalAssetsBreakdown(
      latestReports,
      this.tokens,
      'NMV',
    )

    const canonicalAssetsBreakdown = getCanonicalAssetsBreakdown(this.logger)(
      balances,
      prices,
      this.projects,
    )

    const breakdowns = groupAndMergeBreakdowns(this.projects, {
      external: externalAssetsBreakdown,
      native: nativeAssetsBreakdown,
      canonical: canonicalAssetsBreakdown,
    })

    return {
      result: 'success',
      data: {
        dataTimestamp: latestTimestamp,
        breakdowns,
      },
    }
  }

  private async getDataTimings() {
    const { matching: syncedReportsAmount, different: unsyncedReportsAmount } =
      await this.aggregatedReportStatusRepository.findCountsForHash(
        this.aggregatedConfigHash,
      )

    const latestTimestamp =
      await this.aggregatedReportStatusRepository.findLatestTimestamp()

    const isSynced = unsyncedReportsAmount === 0

    const result = {
      syncedReportsAmount,
      unsyncedReportsAmount,
      isSynced,
      latestTimestamp,
    }

    return result
  }
}

import { shakeUndifindedItem } from '@/functions/arrayMethods'
import { isStringInsensitivelyContain, isStringInsensitivelyEqual } from '@/functions/judgers/areEqual'
import { isNumber, isObject, isString } from '@/functions/judgers/dateType'
import { objectMap, omit } from '@/functions/objectMethods'
import { shrinkToValue } from '@/functions/shrinkToValue'
import { MayArray, MayFunction } from '@/types/constants'

type SearchConfigItemObj = {
  text: string | undefined
  entirely?: boolean
}

export type SearchConfigItem = SearchConfigItemObj | string | undefined

export type SearchOptions<T> = {
  text?: string
  /**
   * different search mode may cause different result count
   * eagle: search for all keywords, if one keyword not match, then this item is not right candidate
   * fuzzy: search for all keywords, if one keyword not match, then this item is still right candidate
   * greedy: search for all keywords, but matched config will be removed from rest search configs.(fuzzy + auto-remove)
   *
   * default: greedy
   */
  searchMode?: 'eagle' | 'fuzzy' | 'greedy'
  matchConfigs?: MayFunction<MayArray<SearchConfigItem>, [item: T]>
}

type MatchInfo<T> = {
  item: T
  matched: boolean
  allConfigs: SearchConfigItemObj[]
  matchedConfigs: {
    isEntirelyMatched: boolean

    config: SearchConfigItemObj
    configIdx: number

    searchedKeywordText: string
    searchedKeywordIdx: number
  }[]
}

/**
 * pure js fn/
 * core of "search" feature
 */
export function searchItems<T>(items: T[], options?: SearchOptions<T>): T[] {
  if (!options) return items
  if (!options.text) return items
  const allMatchedInfos = shakeUndifindedItem(
    items.map((item) =>
      calcMatchInfo({
        item,
        searchText: options.text!,
        searchTarget: options?.matchConfigs ?? getDefaultMatchConfigs(item),
        searchMode: options.searchMode
      })
    )
  )
  const meaningfulMatchedInfos = allMatchedInfos.filter((m) => m?.matched)
  const sortedMatchedInfos = sortByMatchedInfos<T>(meaningfulMatchedInfos)
  const shaked = shakeUndifindedItem(sortedMatchedInfos.map((m) => m.item))
  return shaked
}

/** items: ['hello', 'world'] => config: [{text: 'hello'}, {text: 'world'}] */
function getDefaultMatchConfigs(item: unknown): SearchConfigItemObj[] {
  if (isString(item) || isNumber(item)) return [{ text: String(item) } as SearchConfigItemObj]
  if (isObject(item)) {
    const obj = objectMap(omit(item as any, ['id', 'key']), (value) =>
      isString(value) || isNumber(value) ? ({ text: String(value) } as SearchConfigItemObj) : undefined
    )
    return shakeUndifindedItem(Object.values(obj))
  }
  return [{ text: '' }]
}

function calcMatchInfo<T>({
  item,
  searchText,
  searchTarget,
  searchMode = 'greedy'
}: {
  item: T
  searchText: string
  searchTarget: NonNullable<SearchOptions<T>['matchConfigs']>
  searchMode?: SearchOptions<T>['searchMode']
}) {
  const searchKeyWords = String(searchText).trim().split(/\s|-/)
  const searchConfigs = shakeUndifindedItem(
    [shrinkToValue(searchTarget, [item])]
      .flat()
      .map((c) => (isString(c) ? { text: c } : c) as SearchConfigItemObj | undefined)
  )
  const matchInfo = patchSearchInfos({ item, searchKeyWords, searchConfigs, searchMode })
  return matchInfo
}

/** coreFN: it produce matched search config infos */
function patchSearchInfos<T>(options: {
  item: T
  searchKeyWords: string[]
  searchConfigs: SearchConfigItemObj[]
  searchMode?: SearchOptions<T>['searchMode']
}): MatchInfo<T> | undefined {
  const returnedMatchInfo: MatchInfo<T> = {
    item: options.item,
    allConfigs: options.searchConfigs,
    matched: false,
    matchedConfigs: []
  }
  const keywordPartMustMatch = options.searchMode === 'eagle' || options.searchMode === 'greedy'
  //  should has at least one different matched configIdx between different keywordIdx
  const matchConfigShouldNotSame = options.searchMode === 'greedy'

  const searchKeyWords = options.searchKeyWords
  const searchConfigs = options.searchConfigs
  const currentKeywordMatchedConfigsIndexes: { keywordIndex: number; matchedConfigIndexes: number[] }[] = []
  for (const [keywordIdx, keyword] of searchKeyWords.entries()) {
    let keywardHasMatched = false

    const matchConfigIndexes: number[] = []
    for (const [configIdx, config] of searchConfigs.entries()) {
      const configIsEntirely = config.entirely

      let matchEntirely: boolean | undefined = undefined
      const isMatchEntirely = () => {
        if (matchEntirely == null) {
          const b = isStringInsensitivelyEqual(config.text, keyword)
          matchEntirely = b
        }
        return matchEntirely
      }

      let matchPartial: boolean | undefined = undefined
      const isMatchPartial = () => {
        if (matchPartial == null) {
          const b = isStringInsensitivelyContain(config.text, keyword)
          matchPartial = b
        }
        return matchPartial
      }
      const matched = configIsEntirely ? isMatchEntirely() : isMatchPartial()
      if (matched) {
        keywardHasMatched = true
        matchConfigIndexes.push(configIdx)

        returnedMatchInfo.matched = true
        returnedMatchInfo.matchedConfigs.push({
          config,
          configIdx,
          isEntirelyMatched: isMatchEntirely(),
          searchedKeywordIdx: keywordIdx,
          searchedKeywordText: keyword
        })
      }
    }
    currentKeywordMatchedConfigsIndexes.push({ keywordIndex: keywordIdx, matchedConfigIndexes: matchConfigIndexes })

    // if some keyword don't match anything, means this item is not right candidate
    if (keywordPartMustMatch && !keywardHasMatched) return // if some keyword don't match anything, means this item is not right candidate
  }

  //  should has at least one different matched configIdx between different keywordIdx
  if (matchConfigShouldNotSame) {
    // magic mathematic
    const isDifferentIndexFromDifferentKeyword = () => {
      const keywordCount = currentKeywordMatchedConfigsIndexes.length
      const configSet = new Set<number>()
      for (const { matchedConfigIndexes } of currentKeywordMatchedConfigsIndexes) {
        for (const configIdx of matchedConfigIndexes) {
          configSet.add(configIdx)
        }
      }
      return configSet.size >= keywordCount
    }
    return isDifferentIndexFromDifferentKeyword() ? returnedMatchInfo : undefined
  }
  return returnedMatchInfo
}

function sortByMatchedInfos<T>(matchedInfos: MatchInfo<T>[]) {
  return [...matchedInfos].sort(
    (matchedInfoA, matchedInfoB) => toMatchedStatusSignature(matchedInfoB) - toMatchedStatusSignature(matchedInfoA)
  )
}

/**
 * so user can compare just use return number
 *
 * matchedInfo => [0, 1, 2, 0, 2, 1] =>  [ 2 * 4 + 2 * 2, 1 * 5 + 1 * 1] (index is weight) =>
 * 2 - entirely mathched
 * 1 - partialy matched
 * 0 - not matched
 *
 * @returns item's weight number
 */
function toMatchedStatusSignature<T>(matchedInfo: MatchInfo<T>): number {
  const originalConfigs = matchedInfo.allConfigs
  const entriesSequence = Array.from({ length: originalConfigs.length }, () => 0)
  const partialSequence = Array.from({ length: originalConfigs.length }, () => 0)

  matchedInfo.matchedConfigs.forEach(({ configIdx, isEntirelyMatched }) => {
    if (isEntirelyMatched) {
      entriesSequence[configIdx] = 2 // [0, 0, 2, 0, 2, 0]
    } else {
      partialSequence[configIdx] = 1 // [0, 1, 0, 0, 2, 1]
    }
  })

  const calcCharateristicN = (sequence: number[]) => {
    const max = Math.max(...sequence)
    return sequence.reduce(
      (acc, currentValue, currentIdx) => acc + currentValue * (max + 1) ** (sequence.length - currentIdx),
      0
    )
  }
  const characteristicSequence = calcCharateristicN([
    calcCharateristicN(entriesSequence),
    calcCharateristicN(partialSequence) //  1 * 5 + 1 * 1
  ])
  return characteristicSequence
}

export function dealsWord(count: number): string {
  const n10 = count % 10
  const n100 = count % 100
  if (n10 === 1 && n100 !== 11) return 'дело'
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return 'дела'
  return 'дел'
}

export function carriedNote(count: number, where: string): string {
  if (count === 0) return 'Нечего переносить.'
  const n10 = count % 10
  const n100 = count % 100
  const verb =
    n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? 'перенесены' : 'перенесено'
  return `${count} ${dealsWord(count)} ${verb} на ${where}.`
}

interface Props {
  text: string
  children: React.ReactNode
  width?: string
}

export default function Tooltip({ text, children, width = 'w-56' }: Props) {
  return (
    <span className="relative group inline-flex items-center">
      {children}
      <span
        className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 ${width}
          bg-surface-800 border border-surface-600 text-gray-300 text-xs rounded p-2 leading-relaxed
          pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg`}
      >
        {text}
      </span>
    </span>
  )
}
